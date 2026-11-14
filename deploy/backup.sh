#!/usr/bin/env bash
# deploy/backup.sh —— pii 数据备份
#
# 用法：
#   ./backup.sh daily     每日轻量：SQLite + 侧车文件 + token（不含 images/ archive/）
#   ./backup.sh weekly    每周全量：在 daily 基础上带 images/ 和 archive/
#   ./backup.sh verify    只校验最新一份 daily 备份（cron 之外手动查用）
#
# 三条纪律：
#   1. 先写 .tmp，校验通过才改名 —— 备份目录里不会有"看着像备份、其实打不开"的文件
#   2. SQLite 用 VACUUM INTO 拿一致性快照（直接 cp 正在写的库可能撕裂）
#   3. 校验用容器里的 node:sqlite —— 宿主机的 Python/SQLite 版本太老，不认识 STRICT
#
# 为什么 sidecar 也要备份：auth-token、vapid.json（推送私钥）、策略和标题
# 都在数据目录里，但 pii-deploy 只备份 agent.sqlite*。盘坏了这些会一起丢。
set -u

# 备份包里含 auth-token 和 vapid.json（推送私钥），不能是全局可读
umask 077

DATA=${PII_DATA_DIR:-/opt/pii-test/data}
DEST=${PII_BACKUP_DIR:-/opt/pii-test/backups/scheduled}
CONTAINER=${PII_CONTAINER:-pii-test}
IMAGE=${PII_IMAGE:-pii:server}
DAILY_KEEP=${PII_BACKUP_DAILY_KEEP:-14}
WEEKLY_KEEP=${PII_BACKUP_WEEKLY_KEEP:-4}

MODE=${1:-daily}
STAMP=$(date +%Y%m%d-%H%M%S)

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "❌ $*"; exit 1; }

[ -d "$DATA" ] || die "数据目录不存在：$DATA"
command -v docker >/dev/null 2>&1 || die "找不到 docker"
mkdir -p "$DEST/daily" "$DEST/weekly" || die "建不了备份目录：$DEST"

# 同一时间只允许一个实例（手动跑 + cron 撞车时）
exec 9>"$DEST/.lock"
flock -n 9 || { log "已有备份在跑，本次跳过"; exit 0; }

WORK=$(mktemp -d) || die "建不了临时目录"
trap 'rm -rf "$WORK"' EXIT

# ------------------------------------------------------------------ 快照
# 优先用容器里的 SQLite 做一致性快照；容器没跑就退回 cp（此时无人写入，风险低）
snapshot_db() {
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    # 为什么走 stdin（node -）而不是 node -e：脚本本体是单引号包起来的，
    # 里面没法再写 SQL 需要的单引号；heredoc 用 'JS' 引住，原样传给容器。
    if ! docker exec -i "$CONTAINER" node - >/dev/null 2>&1 <<'JS'
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const target = "/data/.backup-snapshot.sqlite";
try { fs.unlinkSync(target); } catch {}
const db = new DatabaseSync("/data/agent.sqlite");
// SQLite 里双引号是标识符，文件名必须用单引号
db.exec("VACUUM INTO '/data/.backup-snapshot.sqlite'");
db.close();
JS
    then
      die "容器内快照失败（VACUUM INTO）"
    fi
    docker cp "$CONTAINER:/data/.backup-snapshot.sqlite" "$WORK/agent.sqlite" >/dev/null 2>&1 \
      || die "从容器取快照失败"
    docker exec "$CONTAINER" rm -f /data/.backup-snapshot.sqlite >/dev/null 2>&1 || true
    log "SQLite 一致性快照（VACUUM INTO）"
  else
    cp -f "$DATA"/agent.sqlite* "$WORK"/ 2>/dev/null || die "复制 SQLite 失败"
    log "⚠️ 容器未运行，退回直接复制（请留意校验结果）"
  fi
}

# 侧车文件：都是小文件，缺一个就可能丢登录态或推送
stage_sidecars() {
  for f in "$DATA"/*.json "$DATA"/auth-token; do
    [ -e "$f" ] && cp -p "$f" "$WORK"/ 2>/dev/null
  done
}

# ------------------------------------------------------------------ 校验
verify_dir() {
  local dir=$1
  [ -f "$dir/agent.sqlite" ] || { log "❌ 备份里没有 agent.sqlite"; return 1; }
  local out
  out=$(docker run --rm -i --network none -v "$dir:/restore:ro" --entrypoint node "$IMAGE" - 2>&1 <<'JS'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/restore/agent.sqlite", { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const entries = db.prepare("select count(*) n from entries").get().n;
const conversations = db.prepare("select count(*) n from conversations").get().n;
db.close();
console.log(JSON.stringify({ integrity, entries, conversations }));
JS
  ) || { log "❌ 校验容器起不来：$out"; return 1; }

  case "$out" in
    *'"integrity":"ok"'*) ;;
    *) log "❌ integrity_check 未通过：$out"; return 1 ;;
  esac
  log "校验通过 $out"
}

verify_file() {
  local file=$1
  local check="$WORK/check"
  rm -rf "$check" && mkdir -p "$check"
  tar xzf "$file" -C "$check" || { log "❌ 解包失败：$file"; return 1; }
  verify_dir "$check"
}

# ------------------------------------------------------------------ 保留策略
prune() {
  local dir=$1 keep=$2
  ls -1t "$dir"/pii-*.tgz 2>/dev/null | tail -n +$((keep + 1)) | xargs -r rm -f
}

# ------------------------------------------------------------------ 打包
pack() {
  local kind=$1
  local final="$DEST/$kind/pii-$STAMP.tgz"
  local tmp="$final.tmp"

  snapshot_db
  stage_sidecars
  if [ "$kind" = "weekly" ]; then
    [ -d "$DATA/images" ] && cp -a "$DATA/images" "$WORK"/ 2>/dev/null
    [ -d "$DATA/archive" ] && cp -a "$DATA/archive" "$WORK"/ 2>/dev/null
  fi

  tar czf "$tmp" -C "$WORK" . || { rm -f "$tmp"; die "打包失败"; }
  verify_file "$tmp" || { rm -f "$tmp"; die "校验失败，备份未入库"; }

  mv "$tmp" "$final"
  log "✅ 已生成 $(du -h "$final" | cut -f1)  $final"
}

case "$MODE" in
  daily)
    pack daily
    prune "$DEST/daily" "$DAILY_KEEP"
    ;;
  weekly)
    pack weekly
    prune "$DEST/weekly" "$WEEKLY_KEEP"
    ;;
  verify)
    latest=$(ls -1t "$DEST/daily"/pii-*.tgz 2>/dev/null | head -1)
    [ -n "$latest" ] || die "还没有 daily 备份可校验"
    log "校验最新一份：$latest"
    verify_file "$latest" || die "最新备份校验失败"
    ;;
  *)
    die "未知模式：$MODE（daily | weekly | verify）"
    ;;
esac
