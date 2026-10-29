# deploy/ —— 线上那台机器的真实配置

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
