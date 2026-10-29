#!/usr/bin/env bash
# 改完代码后让改动生效：构建前端 + 优雅重启服务端。
#
# 为什么需要两个动作：
#   前端（web/src）→ 产物在 web/dist，服务端每次请求都从磁盘读，**构建即可，不用重启**
#   服务端（src）  → 代码在进程内存里（tsx 没有热重载），**必须重启**
#
# 所以这脚本把两件事合起来，手机上只要说一句「改完了，生效」就行：
#   ./scripts/apply.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "① 构建前端…"
npm --prefix web run build 2>&1 | grep -E "built in|error" || true

echo "② 重启服务端（等当前回答写完再退，launchd 会把它拉起来）…"
bash scripts/restart.sh

echo
echo "提示：手机上刷新页面即可；SSE 会自己重连，会话内容不会丢（快照是权威）。"
