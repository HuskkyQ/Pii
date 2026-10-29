#!/usr/bin/env bash
# /usr/local/bin/pii-deploy —— 宿主机侧的「安全部署器」（不属于仓库，agent 改不到它）
#
# 为什么必须放在宿主机、且不由仓库驱动：
#   如果让容器里的 pii 自己 build/restart，它写错一行代码就会把自己搞死，
#   而那时它已经死了 —— 没人能修。所以执行权留在外面。
#
# 触发方式：容器里 pii 写 /pii-deploy/request（宿主机 /srv/pii-deploy/request）
#   → systemd pii-deploy.path 监听到 → 跑本脚本
#
# 四条安全线：
#   1. 冒烟测试：新镜像先在 18443 端口用「数据库副本」起一遍，跑不通就根本不碰生产
#   2. 生产库备份：切换前把 sqlite 三件套拷一份
#   3. 健康检查 + 自动回滚：切换后 8443 不健康就 tag 回滚并重建（保留上一版镜像 pii:prev）
#   4. 全程 flock：同一时间只有一个部署在跑
set -uo pipefail

REPO=/srv/pii-src
COMPOSE=$REPO/deploy/docker-compose.server.yml
WORK=/srv/pii-deploy
REQ=$WORK/request
STATUS=$WORK/status.json
LOG=$WORK/deploy.log
DATA=/opt/pii-test/data
BACKUPS=/opt/pii-test/backups
SMOKE_PORT=18443
PROD_PORT=8443
DOMAIN=piihub.icu

mkdir -p "$WORK" "$BACKUPS"
exec 9>/var/lock/pii-deploy.lock
flock -n 9 || { echo "已有部署在跑，退出"; exit 0; }

START=$(date +%s)
STEP="init"
ROLLED_BACK=false
NOTE=""
if [ -f "$REQ" ]; then
  NOTE=$(head -c 400 "$REQ" | tr -d '\n')
  rm -f "$REQ"
fi
: > "$LOG"

say() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
write_status() { # state message
  local state=$1 msg=$2
  python3 - "$STATUS" "$state" "$STEP" "$msg" "$START" "$ROLLED_BACK" "$NOTE" <<'PY' 2>/dev/null || true
import json,sys,datetime,os
path,state,step,msg,start,rolled,note = sys.argv[1:8]
d={"state":state,"step":step,"message":msg,"rolledBack":rolled=="true",
   "note":note,"durationSec":int(datetime.datetime.now().timestamp())-int(start),
   "at":datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
tmp=path+".tmp"; open(tmp,"w").write(json.dumps(d,ensure_ascii=False,indent=2)); os.replace(tmp,path)
PY
}
fail() { STEP="${STEP}"; write_status failed "$*"; say "❌ 失败：$*"; exit 1; }

say "=========== pii 自更新开始（来源：$([ -n "$NOTE" ] && echo "pii agent: $NOTE" || echo "手动触发")） ==========="

# ---------------------------------------------------------------- 1. 代码状态
STEP="git"
cd "$REPO" || fail "仓库不存在：$REPO"
DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  say "工作区有改动（先不提交，等冒烟测试过了再说）"
  git diff > "$WORK/last.diff" 2>/dev/null || true
  git status --porcelain >> "$WORK/last.diff" 2>/dev/null || true
  # 工作区脏的时候不能 pull（会被拒），直接拿当前工作区构建
else
  say "工作区干净，拉取上游（Mac 那边可能改过）"
  git pull --ff-only >>"$LOG" 2>&1 || fail "git pull 冲突/分叉：请先在服务器上处理（生产未受影响）"
  git show --stat HEAD > "$WORK/last.diff" 2>/dev/null || true
fi
HEAD=$(git rev-parse --short HEAD)
say "基线 commit: $HEAD  $(git log -1 --format=%s)"

# ---------------------------------------------------------------- 2. 编译 + 构建
STEP="build"
say "构建新镜像 pii:candidate"
if ! docker build -f Dockerfile -t pii:candidate . >>"$LOG" 2>&1; then
  fail "镜像构建失败（语法错误/依赖问题？查看 $LOG）生产未受影响"
fi

# ---------------------------------------------------------------- 3. 冒烟测试
STEP="smoke"
say "冒烟测试：用数据库副本在 :$SMOKE_PORT 起一遍"
rm -rf /tmp/pii-smoke && mkdir -p /tmp/pii-smoke
cp -f "$DATA"/agent.sqlite* /tmp/pii-smoke/ 2>/dev/null
# 模型配置从正在跑的生产容器里读，避免两份配置漂移
PROVIDER=$(docker inspect pii-test --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^PII_PROVIDER=//p' | head -1)
MODEL=$(docker inspect pii-test --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^PII_MODEL=//p' | head -1)
PROVIDER=${PROVIDER:-magpie}
MODEL=${MODEL:-mac/auto/gemini-2.5-flash-lite}
say "  模型：$PROVIDER/$MODEL"
docker rm -f pii-smoke >/dev/null 2>&1
docker run -d --name pii-smoke \
  -p "127.0.0.1:${SMOKE_PORT}:8443" \
  -e PII_AUTH=1 -e PII_CWD=/pii-projects -e PII_HOST=0.0.0.0 -e PII_PORT=8443 \
  -e "PII_PROVIDER=$PROVIDER" -e "PII_MODEL=$MODEL" \
  -e PII_DATA_DIR=/data -e NODE_OPTIONS=--max-old-space-size=384 \
  -e NODE_ENV=production \
  -v /tmp/pii-smoke:/data \
  -v /srv/pii-projects:/pii-projects \
  -v /opt/pii-test/models/models.json:/root/.pi/agent/models.json:ro \
  pii:candidate >/dev/null 2>&1 || fail "冒烟容器启动失败"

SMOKE_OK=0
for _ in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${SMOKE_PORT}/manifest.webmanifest" || echo 000)
  [ "$code" = "200" ] && { SMOKE_OK=1; break; }
done
if [ "$SMOKE_OK" != 1 ]; then
  say "冒烟日志（尾 20 行）："
  docker logs pii-smoke --tail 20 2>&1 | tee -a "$LOG"
  docker rm -f pii-smoke >/dev/null 2>&1
  fail "冒烟测试失败：新代码起不来。生产未受影响 ✅"
fi
say "冒烟通过（manifest 200）"
docker rm -f pii-smoke >/dev/null 2>&1

# ---------------------------------------------------------------- 3.5 提交代码
# 只有冒烟测试过了才提交 —— 坏代码不会在 git 历史里留脏 commit
STEP="commit"
if [ -n "$(git status --porcelain)" ]; then
  say "冒烟已过，现在把这次改动提交"
  git add -A || fail "git add 失败"
  git -c user.name="pii-agent" -c user.email="pii@piihub.icu" \
      commit -q -m "self-update: ${NOTE:-无说明}" || fail "git commit 失败"
  HEAD=$(git rev-parse --short HEAD)
  say "commit: $HEAD"
fi

# ---------------------------------------------------------------- 4. 备份生产库
STEP="backup"
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUPS/$TS"
cp -f "$DATA"/agent.sqlite* "$BACKUPS/$TS"/ 2>/dev/null && say "生产库已备份 -> $BACKUPS/$TS"
ls -1dt "$BACKUPS"/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf   # 只留最近 10 份

# ---------------------------------------------------------------- 5. 切换
STEP="swap"
docker tag pii:server pii:prev >/dev/null 2>&1 || true      # 记住上一版，供回滚
docker tag pii:candidate pii:server
say "重建容器"
if ! docker compose -f "$COMPOSE" up -d --force-recreate >>"$LOG" 2>&1; then
  say "重建失败 → 回滚"
  ROLLED_BACK=true; STEP="rollback"
  docker tag pii:prev pii:server
  docker compose -f "$COMPOSE" up -d --force-recreate >>"$LOG" 2>&1
  fail "容器重建失败，已回滚到上一版"
fi

# ---------------------------------------------------------------- 6. 健康检查
STEP="health"
say "健康检查（最多 60s，要求连续 3 次 200 且不重启）"
ok=0; streak=0
for _ in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PROD_PORT}/manifest.webmanifest" || echo 000)
  restarts=$(docker inspect pii-test --format '{{.RestartCount}}' 2>/dev/null || echo 99)
  if [ "$code" = "200" ] && [ "${restarts:-1}" = "0" ]; then
    streak=$((streak+1)); [ "$streak" -ge 3 ] && { ok=1; break; }
  else
    streak=0
  fi
done

if [ "$ok" != 1 ]; then
  STEP="rollback"
  ROLLED_BACK=true
  say "健康检查未通过 → 自动回滚到 pii:prev"
  docker tag pii:prev pii:server
  docker compose -f "$COMPOSE" up -d --force-recreate >>"$LOG" 2>&1 || true
  sleep 5
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PROD_PORT}/manifest.webmanifest" || echo 000)
  if [ "$code" = "200" ]; then
    fail "新版本不健康，已回滚，线上是老版本（正常服务中）"
  else
    say "⚠️ 回滚后也不健康！请人工介入：docker logs pii-test / journalctl -u caddy"
    fail "新版本不健康且回滚失败 —— 需要 SSH 处理"
  fi
fi

# ---------------------------------------------------------------- 7. 收尾
STEP="verify"
say "公网自检"
pcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/" || echo 000)
say "https://${DOMAIN} -> $pcode（401/200 都算通）"

if [ -n "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]; then
  say "推送到 GitHub（让 Mac 那边能拉到）"
  git push origin HEAD >>"$LOG" 2>&1 && say "已推送" || say "推送失败（不影响线上，稍后手动 push）"
fi

# 清理旧候选镜像，只留最近 3 个
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^pii:candidate' | awk '{print $2}' | tail -n +4 | xargs -r -n1 docker rmi -f >/dev/null 2>&1

STEP="done"
write_status success "部署成功：commit $HEAD"
say "✅ 完成：$HEAD → https://${DOMAIN}"
