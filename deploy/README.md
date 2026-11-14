# deploy/ —— 线上那台机器的真实配置

## 宿主机上的目录约定

```
/srv/pii-projects/        ← 「用 pii 创作的项目」的根。agent 的文件世界，一个子目录一个项目
    my-app/                   agent 在这里干活（git clone 出来的仓库）
    .pii-backup/              旧的手工备份（已废弃，留着当历史）
/srv/pii-src/             ← pii 自己的源码（部署副本，只 pull 不手改）
/opt/pii-test/data/       ← 运行时数据：agent.sqlite（会话/令牌/推送订阅）
/opt/pii-test/models/     ← models.json + gateway-key（有明文密钥，不进仓库）
```

容器里的映射：

| 宿主机 | 容器内 | 用途 |
|---|---|---|
| `/srv/pii-projects` | `/pii-projects` | `PII_CWD` 默认值（规范路径） |
| `/srv/pii-projects` | `/work` | 兼容别名：最早的老会话 cwd 存的是它 |
| `/srv/pii-projects` | `/projects` | 兼容别名：中间版本用过一阵 |
| `/opt/pii-test/data` | `/data` | sqlite |
| `/opt/pii-test/models/models.json` | `/root/.pi/agent/models.json` | 只读 |

**新建一个项目**（在宿主机上做，因为容器里没有 git）：

```bash
git clone git@github.com:you/your-repo.git /srv/pii-projects/your-repo
# 或者在 pii 界面里新建一个空目录，然后在对话里让 agent 干活：
mkdir -p /srv/pii-projects/scratch
```

然后在 pii 里把该会话的「工作目录」选成 `/pii-projects/your-repo`。

## ⚠️ `PII_CWD` 只在「第一次启动」生效

`cwd` 是 **durable 状态**，第一次 `openAgent()` 时写进 sqlite（`documents` 里 kind=`pi.agent`
的文档），之后重启都是从库里恢复 —— **改环境变量 `PII_CWD` 不会生效**。

新会话的 cwd 继承「根会话（id=1）」的 cwd，所以想换默认值就改根会话：

```bash
curl -X POST https://piihub.icu/api/cwd \
  -H "Authorization: Bearer $(docker exec pii-test cat /data/auth-token)" \
  -H 'Content-Type: application/json' \
  -d '{"path":"/pii-projects","conversationId":1}'
```

改完之后**新**会话就是 `/pii-projects`；老会话 sqlite 里存的是 `/work` 或 `/projects`，
靠上面那两个同源兼容挂载继续能用。

`docker-compose.yml` + 根目录 `Caddyfile` 是「一台机器全包」的做法（Caddy 跑容器里）。
但线上这台（阿里云 47.102.100.84）情况不同：

- **80 端口被 teslamate 占了** → Caddy 不能做 HTTP-01，也不能做 http→https 跳转
- pii 容器在 **8443 上跑的是明文 http**，需要一层 TLS 终结
- 所以 Caddy 用 **systemd + 二进制**跑，只占 443

```
手机 ──https:443──> Caddy(systemd) ──http:127.0.0.1:8443──> pii 容器
```

| 本目录文件 | 装到服务器哪里 |
|---|---|
| `Caddyfile` | `/etc/caddy/Caddyfile` |
| `caddy.service` | `/etc/systemd/system/caddy.service` |
| `deploy.sh` | 在服务器上执行，把仓库代码变成运行中的容器 |

## 首次配置

```bash
# 1) 装 Caddy 二进制（v2.10.0 linux amd64）
curl -L -o /tmp/caddy.tar.gz \
  https://github.com/caddyserver/caddy/releases/download/v2.10.0/caddy_2.10.0_linux_amd64.tar.gz
tar xzf /tmp/caddy.tar.gz -C /tmp caddy && install -m 0755 /tmp/caddy /usr/local/bin/caddy

# 2) 装配置
install -D -m 0644 deploy/Caddyfile      /etc/caddy/Caddyfile
install    -m 0644 deploy/caddy.service /etc/systemd/system/caddy.service
mkdir -p /var/lib/caddy
systemctl daemon-reload && systemctl enable --now caddy

# 3) 检查证书是否签下来
journalctl -u caddy -n 50 | grep -i "certificate obtained"
```

## 四个非显然的坑（都踩过）

### 1. 阿里云内网 DNS 不可达 → ACME 直接失败

```
/etc/resolv.conf → 100.100.2.136 / 100.100.2.138   查询超时 3s
症状：docker pull 卡死、Caddy 报 lookup acme-v02.api.letsencrypt.org i/o timeout
```

修法：

```bash
printf 'nameserver 223.5.5.5\nnameserver 119.29.29.29\nnameserver 8.8.8.8\n' > /etc/resolv.conf
mkdir -p /etc/NetworkManager/conf.d
printf '[main]\nrc-manager=unmanaged\n' > /etc/NetworkManager/conf.d/99-dns-unmanaged.conf
systemctl reload NetworkManager
```

### 2. Cloudflare 小黄云开着 → ACME 必失败

`Cannot negotiate ALPN protocol "acme-tls/1"` 的真实含义是
**Let's Encrypt 的验证打到了 Cloudflare 边缘，没到源站**。

→ DNS 记录必须是**灰云（DNS only）**，或者改用 DNS-01 / CF 源站证书。

### 3. Caddy 想抢 80 端口

```
bind: address already in use    ← 80 被 teslamate-grafana 占着
```

→ Caddyfile 里 `auto_https disable_redirects` + `tls { issuer acme { disable_http_challenge } }`
两条一起用，才能只靠 443 签发证书。

### 4. 自更新部署器漏传 APT_MIRROR → 一次部署卡 43 分钟

`docker history pii:server` 里 apt 层是 `APT_MIRROR=mirrors.aliyun.com` + BuildKit，
但 `/usr/local/bin/pii-deploy` 原来跑的是**裸 `docker build`**（经典 builder +
Dockerfile 的默认值 `deb.debian.org`）。参数一变，Docker 层缓存 key 全变；
builder 不同，缓存本来也不共享。于是 apt 层、npm 层每次全部重跑，
境外源实测 17KB/s，22MB 包拖了 **2622 秒**，而生产容器一直好好的没受影响。

→ 两条部署路径现在都调 `deploy/build.sh`：用 **Compose 内置 BuildKit** +
  国内 apt 源，产物经 `PII_IMAGE` 打到指定 tag（构建阶段不覆盖 `pii:server`）。
  配方和记事本只留一份，换源只需
  `APT_MIRROR=mirrors.tencent.com bash deploy/build.sh pii:candidate`。

**为什么用 Compose 内置 BuildKit**：这台机器原来
`~/.docker/cli-plugins/docker-buildx` 是个 228KB 的残缺文件，盖住了系统里正常的
64MB 插件，显式 `DOCKER_BUILDKIT=1 docker build` 会直接 `segmentation fault`。
Compose v2 走自己内置的 BuildKit，不依赖该 CLI 插件，所以构建入口统一到它。

残缺插件后来已重命名备份为 `docker-buildx.broken-20261112`，系统插件
（buildx v0.14.0）恢复可用，原段错误路径实测也通了。但构建入口**没有改回去** ——
两条部署路径继续共用同一套缓存，也不再受宿主机插件状态影响。

**实测**：同一份代码构建 **1 秒、11 层 CACHED**（原来 2622 秒）；
`pii:server` 与运行中的容器全程未被触碰。

## 备份（cron）

`deploy/backup.sh` 三件事：每日轻量、每周全量、校验。

```bash
./backup.sh daily     # SQLite 快照 + *.json + auth-token（不含 images/ archive/）
./backup.sh weekly    # 上面那些 + images/ + archive/
./backup.sh verify    # 校验最新一份 daily
```

两个刻意的设计：

- **先写 `.tmp`，校验通过才改名**：目录里不会出现"看着像备份、其实打不开"的文件；
- **SQLite 用 `VACUUM INTO`**：直接 `cp` 正在写的库可能撕裂（WAL 半截）。

装到宿主机（cron 调用仓库里的脚本，`git pull` 后自动生效）：

```cron
15 4 * * * /srv/pii-src/deploy/backup.sh daily  >> /var/log/pii-backup.log 2>&1
45 4 * * 0 /srv/pii-src/deploy/backup.sh weekly >> /var/log/pii-backup.log 2>&1
```

默认落在 `/opt/pii-test/backups/scheduled/{daily,weekly}/`，daily 留 14 份、weekly 留 4 份。

**恢复演练**（没验证过的备份不算备份）：

```bash
mkdir -p /tmp/pii-restore && tar xzf /opt/pii-test/backups/scheduled/daily/pii-XXXX.tgz -C /tmp/pii-restore
docker run --rm -v /tmp/pii-restore:/restore:ro --entrypoint node pii:server -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/restore/agent.sqlite", { readOnly: true });
  console.log(db.prepare("select count(*) n from entries").get());
  db.close();'
```

真恢复 = 停容器 → 把 `/data` 挪走 → 把包解开到 `/data` → `docker compose up -d`。

> 注意：`pii-deploy` 在切换镜像前也会备份 `agent.sqlite*` 到 `/opt/pii-test/backups/<时间戳>/`，
> 但那**只有 sqlite**，且只在部署时发生 —— 日常数据安全靠上面这条 cron。

## 自我更新（手机上让 pii 改自己）

**设计原则：pii 不能自己执行 docker / 不能自己重启自己** —— 否则它写错一行代码就把自己搞死，而那时已经没人能修了。执行权留在宿主机。

```
手机 → pii(容器) 改 /pii-src 里的源码
     → 写 /pii-deploy/request
     → systemd pii-deploy.path 触发
     → 宿主机 /usr/local/bin/pii-deploy：
          自动 git commit → 构建 pii:candidate → 冒烟测试(18443 + 数据库副本)
          → 备份生产库 → 打 tag pii:prev → 切换 → 健康检查
          → 失败就 tag 回 pii:prev 并重建（自动回滚）
          → 成功则 git push，并把结果写进 /pii-deploy/status.json
```

| 文件 | 在哪 | 作用 |
|---|---|---|
| `/usr/local/bin/pii-deploy` | 宿主机 | 部署器（**不属于仓库**，agent 改不到） |
| `/etc/systemd/system/pii-deploy.{path,service}` | 宿主机 | 监听 `request` 文件并触发 |
| `/srv/pii-deploy/HOWTO.md` | 宿主机 ⇄ 容器 `/pii-deploy` | 给 pii 自己看的操作手册 |
| `/srv/pii-src` | 宿主机 ⇄ 容器 `/pii-src` | 源码工作区 |

四条安全线：**冒烟测试（用数据库副本另起一份）→ 生产库备份 → 健康检查 → 自动回滚**。
任何一步失败，生产环境都不受影响或自动回到上一版。

首次安装（宿主机上，在 `deploy/self-update/` 目录里）：

```bash
install -m 0755 pii-deploy.sh    /usr/local/bin/pii-deploy
install -m 0644 pii-deploy.path  /etc/systemd/system/
install -m 0644 pii-deploy.service /etc/systemd/system/
mkdir -p /srv/pii-deploy
systemctl daemon-reload && systemctl enable --now pii-deploy.path
```

**改了部署器脚本后必须重新 install**：`/usr/local/bin/pii-deploy` 是宿主机副本，
不在 git 工作区里，`git pull` 不会更新它。从仓库根执行：

```bash
install -m 0755 deploy/self-update/pii-deploy.sh /usr/local/bin/pii-deploy
diff -q deploy/self-update/pii-deploy.sh /usr/local/bin/pii-deploy   # 无输出 = 一致
```
