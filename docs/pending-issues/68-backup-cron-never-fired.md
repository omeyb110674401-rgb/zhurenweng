# issue #68：每日备份 cron **从未按预期触发** —— 验了 unit 活着，没验它什么时候跑

父 issue：`59-iteration-baseline.md`（迭代 0 止血：备份 + 恢复校验）与
`66-migration-skipped-on-existing-db.md`（同一次部署装上 cron）。

## 一、现象

2026-09-25 02:10 UTC 去查第一轮自动备份：

- `/var/log/zhurenweng-backup.log` **不存在**；
- `/var/backups/zhurenweng/` 里唯一的 dump 是 09-24 12:00 UTC 我**手动**跑的那一份；
- `/var/log/cron` 里 `daily-backup` 一个字都没出现；
- `crontab -l` 显示那一行确实在，`crond` 是 active + enabled，机器 10 天没重启。

也就是说：从"cron 已上线"到被发现，**没有任何一次自动备份发生过**，业务数据在这十几个小时里
只有一份手动 dump 兜着。

## 二、根因：cron 的时间字段按宿主机时区解释，而我按 UTC 写

宿主机 `Asia/Shanghai`（`date` 与 `date -u` 差 8 小时）。安装时我在脚本注释与
`docs/deploy.md` 里都写着「19:30 UTC = 北京 03:30」，但 crontab 里只有裸的 `30 19 * * *` ——
cronie 会把它解释成 **19:30 北京时间**（= 11:30 UTC）。装它的那一刻是 09-24 13:0x UTC
（= 21:0x 北京），当天的 19:30 北京已经过去，所以第一次触发要等到 09-25 19:30 北京。

文档写的是意图，crontab 写的是解释规则，两者不同 —— 这就是全部的事故成因。

## 三、我上次验错了东西（这条比 bug 本身更值得记）

`66-*.md` 里我专门记了一段："cron 在这台 Alibaba Cloud Linux 3 上的 unit 名是 `crond` 不是
`cron`，第一次查 `is-active cron` 显示 inactive 是我查错了 unit"。那个纠正是对的，但它验的是
**调度器活着**，不是**我的这一行会按我以为的时刻触发**。前者成立时后者可以完全错，而本次正是这样。

留下的规矩：**任何"定时任务已上线"的验收，必须回答两件事 —— 它下一次会在什么时候跑（换算到
宿主机时区说一遍）、它有没有真的跑过一次（看产物与日志，不看 unit 状态）。**

## 四、修法与自证

crontab 顶部加 `CRON_TZ=UTC`，时间字段保持 `30 19`：

```
CRON_TZ=UTC
30 19 * * * /bin/bash /opt/zhurenweng/deploy/daily-backup.sh >> /var/log/zhurenweng-backup.log 2>&1
```

`CRON_TZ` 不是 POSIX，所以我没有"加上就算修好"，而是**当场让它真触发一次**：临时加一行
`15 2 * * *`（同一份 crontab，走同一条 cronie 代码路径）。结果

- `/var/log/cron`：`Sep 25 10:15:01 … CROND[…]: (root) CMD (… daily-backup.sh …)`
  —— 本地 10:15 = **02:15 UTC**，说明 cronie 1.5.2 在 root 的用户 crontab 里认 `CRON_TZ`；
- 跑完的日志：6 项计数逐项「校验通过」（notices 192 / 有摘要 84 / 附件 110 / 抽取正文
  1,491,761 字 / subscriptions 1 / sources 10），产物
  `/var/backups/zhurenweng/zhurenweng-2026-09-25-021501.dump`（1,234,520 字节），保留 7 份；
- 测完把 `15 2` 那行删掉，只留每日那一条。

**顺带得到一条独立证据**：从这份 dump **恢复出来**的库里「有摘要」= 84，与线上直读一致
—— issue #67 放量的 49 条置换确实全部落库、没有半途掉出来。恢复校验原本只是为了兜底，
这次同时充当了 #67 的第三方核对。

## 五、改动的文件

- `deploy/daily-backup.sh`：安装命令补 `CRON_TZ=UTC`，并把"宿主机不是 UTC"这件事写进头注；
- `docs/deploy.md` 第 8 节：同上，并补"怎么确认它真的跑过"；
- 本文件：记下验错对象这件事。

## 六、未做

- **异地第二份**仍未做（FOLLOWUPS 的 #59 行）：本轮只证明"本地这份是每日真的会生成且可恢复"，
  单点风险本身没变。它要先定托管方向（与 GitHub 账号处置是同一个决策）。
