# /pii-deploy —— pii 自我更新的控制面板（容器内看到的就是这个目录）

宿主机路径 `/srv/pii-deploy`，挂载到容器 `/pii-deploy`。

## 你能做什么

| 你写的文件 | 宿主机谁在看 | 效果 |
|---|---|---|
| `/pii-deploy/request` | systemd `pii-deploy.path` | 立刻触发一次「构建 → 冒烟测试 → 切换 → 健康检查」 |
| `/pii-deploy/status.json` | 你（读） | 上一次部署的结果 |
| `/pii-deploy/deploy.log` | 你（读） | 上一次部署的完整日志 |
| `/pii-deploy/last.diff` | 你（读） | 这次部署实际改了什么（自动生成） |

## 自我更新的标准流程

```bash
# 1) 改代码（改的是 git 工作区，不是运行中的镜像）
#    源码在 /pii-src，就是宿主机 /srv/pii-src

# 2) 看一眼自己改了什么（容器里有 git）
cd /pii-src && git status --porcelain && git diff --stat
git log --oneline -5        # 历史
git diff                    # 具体改了哪几行

# 3) 递部署请求（写一行说明，会变成 git commit message）
echo "给 LiveRow 加一个重试按钮" > /pii-deploy/request

# 4) 等 60~180 秒（构建+冒烟+切换+健康检查）
sleep 90

# 5) 看结果
cat /pii-deploy/status.json

# 6) 如果失败，看日志找原因
tail -40 /pii-deploy/deploy.log
```

**注意**：容器会在第 5 步被重建 —— 你自己也在里面，所以这一轮对话会中断。
先跟用户把话说完，再写 `request`。

## 部署器会做什么（4 条安全线）

```
1. 先把你的改动写成 /pii-deploy/last.diff（不提交，等冒烟过）
2. 构建新镜像 pii:candidate
3. 冒烟测试：拿「数据库副本」在 18443 起一遍，manifest 返回 200 才算过
   → 起不来就直接中止：生产一个字节没动，而且 git 历史里也不会留坏 commit
4. 冒烟过了才 git commit，然后备份生产 sqlite → 打 tag pii:prev → 切换 → 健康检查
   → 连续 3 次 200 且没重启才算成功
   → 否则自动 tag 回 pii:prev 并重建容器（回滚）
5. 成功后 git push origin HEAD（Mac 那边 pull 就能拿到）
```

## status.json 的样子

```json
{
  "state": "success",          // 或 "failed"
  "step": "done",              // init/git/build/smoke/backup/swap/health/rollback/done
  "message": "部署成功：commit 6bd8499",
  "rolledBack": false,
  "note": "给 LiveRow 加一个重试按钮",
  "durationSec": 96,
  "at": "2026-10-30T02:10:00+08:00"
}
```

判断成功只看一处：`state == "success"`。

## 你不能做的事

- 不能执行 `docker`（容器里没有 docker，也没有 docker.sock）—— 这是故意的
- **不要在 /pii-src 里跑 `git checkout .` / `git reset --hard` / `git clean -fd`**
  —— 那会把你（或 Mac 那边）正在写的改动直接抹掉。要看就只看，不要回退。
- 不要 `git push`（容器里没有 GitHub 私钥）—— 部署成功后宿主机自动帮你 push
- 不能重启自己（重启 = 宿主机执行 `docker compose up --force-recreate`，由部署器代劳）
- 改 `/pii-deploy` 里的 `request` 内容不会即时生效，因为部署器读到后会立刻删掉它

## 出事了怎么办

| 症状 | 处理 |
|---|---|
| `state=failed, step=build` | 代码编译不过 → 修代码，再写一次 request |
| `state=failed, step=smoke` | 新代码启动就崩 → 看 `deploy.log`，生产没受影响 |
| `state=failed` 且 `rolledBack=true` | 已回到上一版，线上正常 → 修完再试 |
| 回滚后也不健康 | 需要人工 SSH：`docker logs pii-test --tail 100` |

失败后 `/pii-src` 里会留着你的改动（没提交）。修好再递一次 `request` 就行，
不需要手动 revert —— 这正是"冒烟过了才提交"的原因。
