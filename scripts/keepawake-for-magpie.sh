#!/bin/bash
# 防睡眠，跟着 magpie 走：magpie 活着才防睡眠，magpie 退出就自动放开。
#
# 原理：`caffeinate -w <pid>` 会盯着那个 pid，它一退出 caffeinate 也退出。
# 于是：
#   magpie 还没起来  → 这个脚本在等（每 5 秒看一眼，几乎不耗资源）
#   magpie 起来了    → caffeinate 绑定它的 pid，开始防睡眠
#   magpie 退出了    → caffeinate 自动退出 → launchd 的 KeepAlive 再跑一次本脚本 → 回到「等待」
#
# 为什么不用「一直开着 caffeinate」：magpie 不开的时候没必要拦着系统睡眠，
# 而且万一 magpie 崩了，你还想合盖就走人时，系统不该被无缘无故钉住。
set -u

MAGPIE_PATTERN="magpie.app/Contents/MacOS/magpie"

while true; do
  pid="$(pgrep -f "$MAGPIE_PATTERN" | head -1)"
  if [ -n "${pid:-}" ]; then
    echo "[$(date '+%H:%M:%S')] magpie 在跑（pid $pid），开始防睡眠"
    exec /usr/bin/caffeinate -i -s -w "$pid"
  fi
  sleep 5
done
