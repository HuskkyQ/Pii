#!/usr/bin/env bash
# 重启 pii。两条路，优先走「优雅」的那条。
#
#   1. POST /api/restart —— 服务自己等所有会话空闲后退出，launchd 再把它拉起来。
#      好处：不会把正在生成的回答腰斩，也不会陷入「重启命令被续跑再执行一遍」的循环。
#   2. launchctl kickstart -k —— 兜底。HTTP 都不通（代码写崩了、端口没起）时用这个硬重启。
#
# 用法：
#   ./scripts/restart.sh          # 优先优雅重启
#   ./scripts/restart.sh --force  # 直接硬重启（立刻生效，可能打断正在跑的任务）
set -euo pipefail

LABEL="com.sevan.pii"
PORT="${PII_PORT:-8787}"
MODE="${1:-}"

hard_restart() {
  if launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null; then
    echo "已通过 launchd 硬重启（${LABEL}）"
  else
    echo "launchd 里没有 ${LABEL}，退回手动方式：cd 项目目录 && npm start" >&2
    exit 1
  fi
}

if [ "$MODE" = "--force" ]; then
  hard_restart
  exit 0
fi

# 优雅重启：服务会等空闲后退出，由 launchd 拉起
if response="$(curl -s -m 5 -X POST "http://127.0.0.1:${PORT}/api/restart")" && [ -n "$response" ]; then
  echo "已请求优雅重启：$response"
  echo "（等当前这轮回答写完后自动重启；刷新页面即可，SSE 会自己重连）"
else
  echo "HTTP 不通，改走硬重启…" >&2
  hard_restart
fi
