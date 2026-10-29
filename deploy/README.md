# deploy/ —— 线上那台机器的真实配置

## 宿主机上的目录约定

```
/srv/projects/            ← 「项目根」。agent 的文件世界，一行一个项目
    my-app/                   agent 在这里干活（git clone 出来的仓库）
    .pii-backup/              旧的手工备份（已废弃，留着当历史）
/srv/pii-src/             ← pii 自己的源码（部署副本，只 pull 不手改）
/opt/pii-test/data/       ← 运行时数据：agent.sqlite（会话/令牌/推送订阅）
/opt/pii-test/models/     ← models.json + gateway-key（有明文密钥，不进仓库）
```

容器里的映射：

| 宿主机 | 容器内 | 用途 |
|---|---|---|
| `/srv/projects` | `/projects` | `PII_CWD` 默认值 |
| `/srv/projects` | `/work` | 兼容别名（老会话 cwd 存的是 `/work`） |
| `/opt/pii-test/data` | `/data` | sqlite |
| `/opt/pii-test/models/models.json` | `/root/.pi/agent/models.json` | 只读 |

**新建一个项目**（在宿主机上做，因为容器里没有 git）：

```bash
git clone git@github.com:you/your-repo.git /srv/projects/your-repo
# 或者在 pii 界面里新建一个空目录，然后在对话里让 agent 干活：
mkdir -p /srv/projects/scratch
```

然后在 pii 里把该会话的「工作目录」选成 `/projects/your-repo`。

## ⚠️ `PII_CWD` 只在「第一次启动」生效

`cwd` 是 **durable 状态**，第一次 `openAgent()` 时写进 sqlite（`documents` 里 kind=`pi.agent`
的文档），之后重启都是从库里恢复 —— **改环境变量 `PII_CWD` 不会生效**。

新会话的 cwd 继承「根会话（id=1）」的 cwd，所以想换默认值就改根会话：

```bash
curl -X POST https://piihub.icu/api/cwd \
  -H "Authorization: Bearer $(docker exec pii-test cat /data/auth-token)" \
  -H 'Content-Type: application/json' \
  -d '{"path":"/projects","conversationId":1}'
```

改完之后**新**会话就是 `/projects`；老会话 sqlite 里存的是 `/work`，
靠上面那个 `/srv/projects -> /work` 的兼容挂载继续能用。

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

## 两个非显然的坑（都踩过）

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

首次安装（宿主机上）：

```bash
install -m 0755 pii-deploy.sh    /usr/local/bin/pii-deploy
install -m 0644 pii-deploy.path  /etc/systemd/system/
install -m 0644 pii-deploy.service /etc/systemd/system/
mkdir -p /srv/pii-deploy
systemctl daemon-reload && systemctl enable --now pii-deploy.path
```
