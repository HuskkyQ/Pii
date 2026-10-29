# self-update/ —— pii 自我更新（手机上说一句话就上线）

## ⚠️ 这里的文件是**备份**，不是执行源

真正执行的是宿主机上的这几份，**故意不从仓库读取**：

| 仓库里的备份 | 宿主机上真正生效的 |
|---|---|
| `pii-deploy.sh` | `/usr/local/bin/pii-deploy` |
| `pii-deploy.path` | `/etc/systemd/system/pii-deploy.path` |
| `pii-deploy.service` | `/etc/systemd/system/pii-deploy.service` |
| `HOWTO.md` | `/srv/pii-deploy/HOWTO.md`（容器内 `/pii-deploy/HOWTO.md`） |

**为什么故意脱离仓库**：如果部署器本身由仓库驱动，pii 写坏一行 `pii-deploy.sh`
就能把自己彻底搞死 —— 那时它已经死了，只能人工 SSH 救。执行权必须在仓库之外。

改了这里的文件之后，必须手动 `install` 到宿主机（见下方命令），否则不生效。

## 工作原理

```
手机 → pii(容器) 改 /pii-src 里的源码
     → 写 /pii-deploy/request
     → systemd pii-deploy.path 检测到文件
     → 宿主机执行 /usr/local/bin/pii-deploy：
          1) 把改动写成 /pii-deploy/last.diff（不提交）
          2) docker build → pii:candidate
          3) 冒烟测试：数据库副本 + :18443 起一遍，manifest 必须 200
             ↳ 不通过就中止：生产零影响，git 历史也不留坏 commit
          4) 冒烟过了才 git commit
          5) 备份生产 sqlite（留最近 10 份）→ tag pii:prev → 切换容器
          6) 健康检查：连续 3 次 200 且 RestartCount=0
             ↳ 不通过就 tag 回 pii:prev + 重建（自动回滚）
          7) 成功 → git push origin HEAD（Mac 能拉到）
          8) 结果写入 /pii-deploy/status.json
```

## 安装 / 更新部署器

```bash
install -m 0755 pii-deploy.sh       /usr/local/bin/pii-deploy
install -m 0644 pii-deploy.path     /etc/systemd/system/
install -m 0644 pii-deploy.service  /etc/systemd/system/
mkdir -p /srv/pii-deploy && cp HOWTO.md /srv/pii-deploy/HOWTO.md
systemctl daemon-reload && systemctl enable --now pii-deploy.path
```

## 实测记录（2026-10-30）

| 场景 | 结果 |
|---|---|
| 正常改动（加一行注释） | `success`，112s，自动 commit + push，线上 401 |
| 装 git 的 Dockerfile 改动 | `success`，167s，冒烟测试跑的是新镜像 |
| **故意写坏代码** | `failed/smoke`，70s，**线上 running / RestartCount=0 / 公网 401**，git 无坏 commit，工作区留着改动等人修 |
