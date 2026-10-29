#!/usr/bin/env bash
# deploy/deploy.sh —— 服务器上的「一条命令部署」
#
#   cd /srv/pii-src && ./deploy/deploy.sh
#
# 做的事：拉代码 → 重建镜像 → 重启容器 → 同步 Caddy 配置 → 全链路自检
# 原则：任何一步失败就 exit，不会留下半死不活的状态。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOMAIN="${PII_DOMAIN:-piihub.icu}"
LOCAL_PORT=8443

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 前置检查
say "0/6 前置检查"
command -v docker >/dev/null || die "没有 docker"
command -v caddy  >/dev/null || die "没有 caddy 二进制，见 deploy/README.md"
docker network inspect pii-net >/dev/null 2>&1 || docker network create pii-net
[ -f /opt/pii-test/models/models.json ] || die "缺少 /opt/pii-test/models/models.json（里面有模型密钥）"
mkdir -p /opt/pii-test/data /srv/pii-work

# ---------------------------------------------------------------- 1. 拉代码
say "1/6 拉取代码"
if [ -d .git ]; then
  git rev-parse --abbrev-ref HEAD
  git log --oneline -1
  git pull --ff-only || die "git pull 失败（本地有冲突改动？）"
else
  die "这不是 git 仓库，先从 GitHub clone 到 /srv/pii-src"
fi

# ---------------------------------------------------------------- 2. 重建镜像
say "2/6 构建镜像 pii:server"
docker compose -f deploy/docker-compose.server.yml build

# ---------------------------------------------------------------- 3. 切容器
say "3/6 重启容器"
docker compose -f deploy/docker-compose.server.yml up -d

say "    等待健康（最多 60s）"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${LOCAL_PORT}/manifest.webmanifest" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || {
  docker compose -f deploy/docker-compose.server.yml logs --tail 40 pii
  die "容器起来但 8443 不健康"
}
echo "    8443 健康 ✅"

# ---------------------------------------------------------------- 4. Caddy 配置
say "4/6 同步 Caddy 配置"
if ! cmp -s deploy/Caddyfile /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
  echo "    Caddyfile 已更新（旧文件已备份）"
else
  echo "    Caddyfile 无变化"
fi
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddyfile 校验失败"
systemctl reload caddy

# ---------------------------------------------------------------- 5. 自检
say "5/6 全链路自检"
printf '    本机 8443      : '
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${LOCAL_PORT}/" || true

printf '    公网 https     : '
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/" || echo 000)
echo "$code（401/200 都算通，401 = 需要登录）"
[ "$code" = "000" ] && die "公网 https 访问失败"

printf '    证书到期       : '
echo | openssl s_client -connect "127.0.0.1:443" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//' || echo "读不到"

# ---------------------------------------------------------------- 6. 提示
say "6/6 完成"
cat <<EOF

  部署完成：https://${DOMAIN}
  镜像      : $(docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}}' | grep '^pii:server' || echo '?')
  容器      : $(docker ps --filter name=pii-test --format '{{.Status}}')
  Caddy     : $(systemctl is-active caddy)

  换域名/换证书出问题时看：
    journalctl -u caddy -n 80 --no-pager
    docker compose -f deploy/docker-compose.server.yml logs --tail 80 pii

EOF
