#!/usr/bin/env bash
# deploy/verify-sync.sh —— 三处对齐检查（在 Mac 上跑）
#
#   ./deploy/verify-sync.sh
#
# 检查「本地 / GitHub / 服务器」三处的 HEAD 是否一致，以及服务器上
# 正在跑的那份代码和容器镜像是否对得上。改动完随时跑一下，别靠记忆。
#
# 环境变量：
#   PII_SERVER   默认 root@47.102.100.84
#   PII_KEY      默认 ~/.ssh/id_rsa
set -uo pipefail

SERVER="${PII_SERVER:-root@47.102.100.84}"
KEY="${PII_KEY:-$HOME/.ssh/id_rsa}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -i "$KEY" "$SERVER")
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT" || exit 1

ok()   { printf '  \033[32m✅\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠️ \033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m❌\033[0m %s\n' "$*"; }

echo "=== 1. 本地工作区 ==="
DIRTY=$(git status --porcelain)
if [ -z "$DIRTY" ]; then ok "干净，没有未提交改动"; else
  warn "有未提交改动："; echo "$DIRTY" | sed 's/^/       /'
fi
LOCAL=$(git rev-parse --short HEAD)
LOCAL_SUBJECT=$(git log -1 --format=%s)
echo "      HEAD = $LOCAL  $LOCAL_SUBJECT"

echo
echo "=== 2. GitHub（origin/main）==="
if ! GIT_SSH_COMMAND='ssh -o BatchMode=yes' git fetch -q origin 2>/dev/null; then
  bad "fetch 失败（网络或 SSH key？）"; exit 1
fi
REMOTE=$(git rev-parse --short origin/main)
REMOTE_SUBJECT=$(git log -1 --format=%s origin/main)
echo "      HEAD = $REMOTE  $REMOTE_SUBJECT"
if [ "$LOCAL" = "$REMOTE" ]; then ok "本地 == 远程"; else
  if git merge-base --is-ancestor "$REMOTE" HEAD; then
    warn "本地领先远程 $(git rev-list --count origin/main..HEAD) 个提交 → 需要 git push"
  elif git merge-base --is-ancestor HEAD "$REMOTE"; then
    warn "本地落后远程 $(git rev-list --count HEAD..origin/main) 个提交 → 需要 git pull --rebase"
  else
    bad "本地与远程分叉了 → 需要 git pull --rebase 处理"
  fi
fi

echo
echo "=== 3. 服务器（/srv/pii-src）==="
SRV_LINE=$("${SSH[@]}" 'cd /srv/pii-src && echo "$(git rev-parse --short HEAD)|$(git log -1 --format=%s)|$(git status --porcelain | wc -l)"' 2>/dev/null)
if [ -z "$SRV_LINE" ]; then bad "SSH 不通或仓库缺失"; exit 1; fi
SRV_HEAD=${SRV_LINE%%|*}
REST=${SRV_LINE#*|}
SRV_SUBJECT=${REST%|*}
SRV_DIRTY=${REST##*|}
echo "      HEAD = $SRV_HEAD  $SRV_SUBJECT"
[ "$SRV_DIRTY" = "0" ] && ok "工作区干净" || warn "服务器工作区有 $SRV_DIRTY 个未提交文件（pii 自我更新改过但没部署？）"
if [ "$SRV_HEAD" = "$REMOTE" ]; then ok "服务器 == 远程"; else
  warn "服务器不等于远程 → 去服务器跑：cd /srv/pii-src && git pull --ff-only（或 ./deploy/deploy.sh）"
fi

echo
echo "=== 4. 线上容器 ==="
CONT=$("${SSH[@]}" 'docker ps --filter name=pii-test --format "{{.Status}}" 2>/dev/null' 2>/dev/null)
IMG=$("${SSH[@]}" 'docker images --format "{{.CreatedSince}}" pii:server 2>/dev/null' 2>/dev/null)
HEALTH=$("${SSH[@]}" 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:8443/manifest.webmanifest' 2>/dev/null)
echo "      容器: ${CONT:-未运行}   镜像 pii:server 构建于: ${IMG:-?}"
if [ "$HEALTH" = "200" ]; then ok "8443 manifest 200"; else bad "8443 返回 ${HEALTH:-无响应}"; fi

echo
echo "=== 5. 最后改代码的提交 vs 镜像构建时间 ==="
LAST_CODE=$("${SSH[@]}" 'cd /srv/pii-src && git log -1 --format=%ct -- src web Dockerfile package.json' 2>/dev/null)
IMG_TS=$("${SSH[@]}" 'docker image inspect pii:server --format "{{.Created}}" 2>/dev/null | xargs -r -I{} date -d {} +%s' 2>/dev/null)
if [ -n "${LAST_CODE:-}" ] && [ -n "${IMG_TS:-}" ] && [ "$IMG_TS" -ge "$LAST_CODE" ] 2>/dev/null; then
  ok "镜像不比代码旧（代码 $(python3 -c "import datetime,sys;print(datetime.datetime.fromtimestamp(int(sys.argv[1])).strftime('%m-%d %H:%M'))" "$LAST_CODE") ≤ 镜像）"
else
  warn "镜像可能比代码旧（只有改代码/Dockerfile 才需要重建；纯文档改动不用）"
fi

echo
echo "=== 结论 ==="
if [ "$LOCAL" = "$REMOTE" ] && [ "$SRV_HEAD" = "$REMOTE" ] && [ -z "$DIRTY" ] && [ "$HEALTH" = "200" ]; then
  printf '  \033[32m三处一致，线上健康。\033[0m\n'
else
  printf '  \033[33m还有不一致的地方，看上面标了 ⚠️/❌ 的行。\033[0m\n'
fi
