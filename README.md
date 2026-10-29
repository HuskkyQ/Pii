# pii

自托管的 durable agent。跑在自己的机器或服务器上，手机和电脑看同一个会话。

## 它解决什么

| 能力 | 说明 |
|---|---|
| **关掉浏览器它还在跑** | 任务在服务端，不依赖连接；断了重连不丢 |
| **进程崩了能接上** | 每一步存 checkpoint，重启后从断点续跑 |
| **手机上就是 app** | PWA + Web Push，锁屏也能收到「回答完成」 |
| **工具要你点头** | `bash` / 写文件默认走审批，可按会话调策略 |
| **上下文不会爆** | 自动压缩 + 原文归档 + 图片外置（图片只留路径，模型按需读） |
| **能改自己的代码** | agent 的工作目录就是你 clone 的项目，改完 `git push` 即可 |

模型复用 `~/.pi/agent/models.json` 里已配好的 provider，不额外维护一份密钥。

## 技术底座

| 层 | 用什么 |
|---|---|
| agent 运行时 | [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) |
| 模型调用 | `@earendil-works/pi-ai` |
| 服务端 | Hono + `node:sqlite` |
| 前端 | Vite + React + TypeScript + Tailwind v4 + shadcn/ui |

## 跑起来

```bash
npm install
npm --prefix web install

npm run build:web && npm start     # http://127.0.0.1:8787
```

## 更多

实现细节、环境变量、API、部署到服务器、性能优化和踩过的坑，都在
[docs/ENGINEERING.md](docs/ENGINEERING.md)。
