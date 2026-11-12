#!/usr/bin/env bash
# deploy/build.sh —— 唯一的镜像构建入口。
#
# 用法：bash deploy/build.sh [目标 tag]     默认 pii:candidate
#   deploy/deploy.sh              调它产出 pii:server
#   deploy/self-update/pii-deploy.sh  调它产出 pii:candidate
#
# 为什么要有它：以前构建命令散在两处，各自写参数和 builder ——
#   deploy/deploy.sh                → docker compose build（BuildKit + 阿里云 apt 源）
#   deploy/self-update/pii-deploy.sh → 裸 docker build（经典 builder + 默认 deb.debian.org）
# 后者漏传 APT_MIRROR，又用了不同的 builder：参数不同 → Docker 层缓存 key 全变，
# builder 不同 → 缓存本来也不共享。于是 apt / npm 层每次全部重跑，
# 从境外 deb.debian.org 重下 22MB 包（这台机器实测 17KB/s），一次部署跑了 2622 秒。
#
# 现在配方和记事本只有一份：固定 BuildKit、固定国内 apt 源、固定仓库根做 context。
# 想换源：APT_MIRROR=mirrors.tencent.com bash deploy/build.sh pii:candidate
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-pii:candidate}"
APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"

echo "构建镜像 $TAG（APT_MIRROR=$APT_MIRROR, DOCKER_BUILDKIT=1）"
cd "$REPO_ROOT"
DOCKER_BUILDKIT=1 docker build \
  --build-arg "APT_MIRROR=$APT_MIRROR" \
  -f Dockerfile \
  -t "$TAG" \
  .
