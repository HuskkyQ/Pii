# pii 的运行镜像。
#
# 为什么要分两阶段：前端要 `npm run build` 出 web/dist，而运行时只需要那个产物 + 服务端依赖。
# 为什么运行时还留着 devDependencies：服务端是用 `tsx` 直接跑 .ts 的（没有编译步骤），
#   tsx 在 devDependencies 里 —— 所以运行阶段也要 `npm ci` 装全量。
# 基础镜像可以用 --build-arg 换（国内服务器常见做法：换成自己镜像源里有的 tag）
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM ${NODE_IMAGE}
WORKDIR /app

# 服务端依赖（含 tsx）
COPY package.json package-lock.json ./
RUN npm ci

# 源码 + 前端构建产物
COPY . .
COPY --from=web /app/web/dist ./web/dist

# 容器里必须监听 0.0.0.0，否则反向代理进不来
ENV PII_HOST=0.0.0.0 \
    PII_PORT=8787 \
    PII_DATA_DIR=/data \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8787

# 健康检查走公开路径（开了鉴权后 /api/* 会 401，别拿它当探针）
# 探针端口必须跟运行时一致：compose 里把 PII_PORT 改成 8443 后，
# 写死 8787 会让容器永远显示 unhealthy（服务其实是好的）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PII_PORT||8787)+'/manifest.webmanifest').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server/main.ts"]
