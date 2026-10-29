#!/usr/bin/env bash
# 用 Tailscale 把本地 pii 暴露成一个私有 https 地址。
#
# 为什么必须 https：
#   iOS Safari 只在「安全上下文」里注册 service worker、给麦克风、给推送。
#   http://192.168.x.x 不算安全上下文 → 加不到主屏幕（或加了也不是独立 app）。
#   tailscale serve 会自动签证书，于是 PWA 全部能力都开了。
#
# 用法：
#   ./scripts/tailscale-setup.sh          # 挂上（后台常驻）
#   ./scripts/tailscale-setup.sh status   # 看当前状态
#   ./scripts/tailscale-setup.sh off      # 撤掉
set -euo pipefail

PORT="${PII_PORT:-8787}"
ACTION="${1:-up}"

# macOS 图形版装完后 CLI 不在 PATH 里，它藏在 app bundle 里（那个包也提供不了 `tailscale up`，
# 守护进程是 GUI 自己在跑）。所以先把两种位置都找一遍。
find_cli() {
  if command -v tailscale >/dev/null 2>&1; then command -v tailscale; return 0; fi
  for candidate in \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "/Applications/Tailscale.app/Contents/MacOS/tailscale" \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

if ! TS="$(find_cli)"; then
  cat >&2 <<'EOF'
没有找到 tailscale。两种装法，选一个：

  ① 图形版（推荐，官网下载）
     https://tailscale.com/download/mac   → 下载 macOS（standalone，不是 App Store 版）
     装完打开 App 登录。CLI 在 /Applications/Tailscale.app/Contents/MacOS/Tailscale
     （本脚本会自动找到这个路径，不用配 PATH）

  ② 或者一个命令搞定（会问你的开机密码）
     brew install --cask tailscale

  别装 Mac App Store 那个版本：它是沙箱的，没有 CLI，本脚本调不到 `tailscale serve`。

  iPhone：App Store 装 Tailscale，登录同一个账号（这一步只是让手机加入同一个私有网络）
EOF
  exit 1
fi

case "$ACTION" in
  off)
    "$TS" serve reset
    echo "已撤掉 tailscale serve"
    exit 0
    ;;
  status)
    "$TS" serve status
    "$TS" status | head -5
    exit 0
    ;;
esac

# 前置检查：pii 得先在跑
if ! curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/state"; then
  echo "127.0.0.1:${PORT} 上没看到 pii。先在另一个终端跑：npm start" >&2
  exit 1
fi

# 新版 tailscale 支持 `serve --bg <port>`；老版要用 `serve https / http://...`
# 坑：这个命令会先打印一段提示再挂起等 stdin / 轮询，直接跑会把脚本卡死，
# 所以统一套一层超时，然后回头用 `serve status` 判断到底成没成。
run_bg() {
  if command -v timeout >/dev/null 2>&1; then timeout 20 "$@"; 
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout 20 "$@";
  else "$@" & local pid=$!; ( sleep 20; kill "$pid" 2>/dev/null ) & wait "$pid" 2>/dev/null || true; fi
}

if "$TS" serve --help 2>&1 | grep -q -- '--bg'; then
  serve_out="$(run_bg "$TS" serve --bg "$PORT" </dev/null 2>&1 || true)"
else
  dns_name="$("$TS" status --json 2>/dev/null | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      try { const j=JSON.parse(d); console.log(j.Self.DNSName.replace(/\.$/,"")); }
      catch { console.log("localhost"); }
    })' || echo localhost)"
  serve_out="$(run_bg "$TS" serve --bg "https://${dns_name}" "http://127.0.0.1:${PORT}" </dev/null 2>&1 || true)"
fi

# 真正的判据：配置有没有落地（而不是命令退码——它可能是被超时杀掉的）
if "$TS" serve status 2>/dev/null | grep -q "No serve config"; then
  printf '%s\n' "$serve_out"
  cat <<'EOF'

↑ 如果上面写着 "Serve is not enabled on your tailnet"：这不是错误，是 Tailscale 的一次性开关。
  打开那个链接（或 https://login.tailscale.com/admin/settings/features
  → 勾上 "Serve"），点 Enable，然后重跑：npm run tailscale
EOF
  exit 1
fi

printf '%s\n' "$serve_out"

echo
echo "已挂上。tailscale serve 地址（在 tailnet 内可访问）："
"$TS" serve status 2>/dev/null | sed -n '1,10p' || true
echo
cat <<EOF
下一步（在 iPhone 上）：
  1. Tailscale 开着（它会顶掉手机上的其他 VPN —— iOS 只能同时一个）
  2. Safari 打开上面那个 https 地址
  3. 分享 → 添加到主屏幕
  4. 从主屏幕图标进入（此时才是 standalone，service worker 才注册、推送才可用）
EOF
