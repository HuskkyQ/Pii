#!/usr/bin/env bash
# 把 pii 装成 macOS LaunchAgent：开机自启、挂了自动拉起、脱离终端。
#
# 为什么需要：用 `npm start` 起在终端里的服务，终端一关/会话一回收就收到 SIGTERM 挂掉。
# LaunchAgent 由 launchd 托管，不属于任何 shell，进程死了会被立刻重启。
#
#   ./scripts/install-launchd.sh           # 安装并立即启动
#   ./scripts/install-launchd.sh status    # 看状态
#   ./scripts/install-launchd.sh logs      # 跟踪日志
#   ./scripts/install-launchd.sh uninstall # 卸掉（服务停止，不再自启）
set -euo pipefail

LABEL="com.sevan.pii"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${PII_DATA_DIR:-$HOME/.pii}"
TSX="$PROJECT_DIR/node_modules/.bin/tsx"

# launchd 的 PATH 很干净，node 不在里面就找不到 —— 把当前 node 的目录带上
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PATH_VALUE="${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

status() {
  # 用 launchd 自己的视图，比 `launchctl list` 稳（list 在重启的瞬间可能读到空）
  local info
  info="$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null || true)"
  if [ -z "$info" ]; then
    echo "未加载（用 ./scripts/install-launchd.sh install 装）"
  else
    local state pid
    state="$(printf '%s\n' "$info" | awk -F' = ' '/^[[:space:]]*state = /{print $2; exit}')"
    pid="$(printf '%s\n' "$info" | awk -F' = ' '/^[[:space:]]*pid = /{print $2; exit}')"
    echo "已加载：state=${state:-?} pid=${pid:-（等待重启）}"
  fi
  # 探活要用**公开**路径：开了鉴权后 /api/state 无令牌会返回 401，
  # 拿 401 当“挂了”是误报。
  echo -n "本地 8787："
  curl -s -o /dev/null -m 3 -w "%{http_code}\n" http://127.0.0.1:8787/manifest.webmanifest || echo "不通"
  echo "日志：$LOG_DIR/pii.log"
}

case "${1:-install}" in
  status) status; exit 0 ;;
  logs) tail -f "$LOG_DIR/pii.log" ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已卸载 ${LABEL}（日志留在 $LOG_DIR/pii.log）"
    exit 0
    ;;
  install) ;;
  *) usage ;;
esac

if [ ! -x "$TSX" ]; then
  echo "没找到 $TSX，先在该目录跑过 npm install 吗？" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <!-- 直接跑 tsx，不经过 npm：launchd 里的 npm 容易因为 PATH/shell 差异起不来 -->
  <key>ProgramArguments</key>
  <array>
    <string>${TSX}</string>
    <string>${PROJECT_DIR}/src/server/main.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH_VALUE}</string>
    <!-- 记账用的 npm 变量，避免个别依赖读不到 -->
    <key>npm_config_prefix</key>
    <string>${NODE_BIN_DIR}</string>
    <!--
      推送的 VAPID 联络人。Apple 的推送服务（web.push.apple.com）会校验这个值，
      用 mailto:pii@localhost 这种假地址会被拒 403 —— 必须是你真能收信的地址。
      装的时候传：PII_VAPID_SUBJECT=mailto:you@example.com ./scripts/install-launchd.sh
    -->
    <!-- 公网暴露时必须有：PII_AUTH=1 才要求令牌 -->
    <key>PII_AUTH</key>
    <string>${PII_AUTH:-0}</string>
    <key>PII_VAPID_SUBJECT</key>
    <string>${PII_VAPID_SUBJECT:-mailto:pii@localhost}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <!--
    无条件重启：不管退出码是 0 还是非 0，也不管是被 SIGTERM 还是 SIGKILL 弄死的。
    为什么不用 SuccessfulExit=false：我们的 SIGTERM 处理是优雅退出（exit 0），
    那种情况下 launchd 会认为“你是主动停的”，不重启 —— 而我们要的正是“挂了也活过来”。
    代价：想真正停服务得用 launchctl bootout，单纯 kill 会被它拉回来（下面有命令）。
  -->
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/pii.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/pii.log</string>

</dict>
</plist>
PLIST_EOF

# 先卸掉旧的（存在的话）
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

# 等它真的消失再装 —— bootout 是异步的，紧接着 bootstrap 会撞上
# "Bootstrap failed: 5: Input/output error"（这个报错很误导，其实是还没来得及卸）
for _ in $(seq 1 20); do
  if ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

# bootstrap 也重试几次，同样的理由
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then break; fi
  sleep 1
done

launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true

# 服务起来要 10 秒左右（tsx 编译 + SQLite + 读 models.json），多等一会儿
for _ in $(seq 1 20); do
  if curl -sf -o /dev/null -m 2 http://127.0.0.1:8787/api/state; then break; fi
  sleep 1
done
status
echo
echo "提示：现在服务由 launchd 托管，**别再手动 npm start**（pid 锁会拒绝第二个实例）。"
echo "      重启（改完代码）：launchctl kickstart -k gui/$(id -u)/${LABEL}"
echo "      真停止（kill 会被自动拉起来）：launchctl bootout gui/$(id -u)/${LABEL}"
