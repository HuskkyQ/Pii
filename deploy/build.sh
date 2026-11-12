#!/usr/bin/env bash
# deploy/build.sh —— 唯一的镜像构建入口。
#
# 用法：bash deploy/build.sh [目标 tag]     默认 pii:candidate
#   deploy/deploy.sh                    调它产出 pii:server
#   deploy/self-update/pii-deploy.sh    调它产出 pii:candidate
# 换源：APT_MIRROR=mirrors.tencent.com bash deploy/build.sh pii:candidate
#
# 为什么要有它：以前构建命令散在两处，各自写参数和 builder ——
#   deploy/deploy.sh                  → docker compose build（BuildKit + 阿里云 apt 源）
#   deploy/self-update/pii-deploy.sh   → 裸 docker build（经典 builder + 默认 deb.debian.org）
# 后者漏传 APT_MIRROR，又用了不同的 builder：参数不同 → Docker 层缓存 key 全变，
# builder 不同 → 缓存本来也不共享。于是 apt / npm 层每次全部重跑，
# 从境外 deb.debian.org 重下 22MB 包（这台机器实测 17KB/s），一次部署跑了 2622 秒。
#
# 为什么用 `docker compose build` 而不是 `DOCKER_BUILDKIT=1 docker build`：
#   服务器上 ~/.docker/cli-plugins/docker-buildx 曾是个 228KB 的残缺文件，
#   盖住了系统里正常的 64MB 插件，显式开 BuildKit 会段错误；现已重命名备份修复。
#   但构建入口仍统一到 Compose 内置 BuildKit（不依赖 CLI 插件）：
#   两条部署路径共用同一套缓存，也不再受宿主机插件状态影响。
#   实测同一份代码：1 秒完成、11 层 CACHED（修复前 2622 秒）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-pii:candidate}"
APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"

echo "构建镜像 $TAG（APT_MIRROR=$APT_MIRROR, Compose 内置 BuildKit）"
cd "$REPO_ROOT"
# PII_IMAGE 让 compose 把产物打到指定 tag，避免构建阶段就覆盖生产用的 pii:server。
# APT_MIRROR 与 compose 里的 build.args 用同一个变量，两处不会再漂移。
PII_IMAGE="$TAG" APT_MIRROR="$APT_MIRROR" \
  docker compose -f deploy/docker-compose.server.yml build
