# 部署脚本

两种通道，**当前只有第二种可用**。

## 1. `sync-files-local.sh` —— 当前主用（增量）

本地文件 → gzip → base64 → `workbench exec` 写入服务器，逐文件校验 sha256。
不受仓库可达性影响，改几个文件就传几个文件。

```bash
bash deploy/sync-files-local.sh src/app/page.tsx src/lib/dates.ts
# 然后在服务器上重建镜像并重启 web（脚本头部注释给了命令）
```

## 2. `deploy-NN.sh` —— 历史脚本，已不可用

`deploy-23/24/25/29/30/31/32.sh` 是各 issue 上线时的一次性脚本，都从
`codeload.github.com` 取源码包整包覆盖。

**2026-09-21 起 GitHub 账号 `omeyb110674401-rgb` 被停用**（仓库页与 codeload
均 404），这条通道断了，这批脚本原样跑会失败。保留它们只是为了留档「当时怎么
部署的」，不要照着执行 —— 恢复推送通道（或换托管）后再评估是否复用。

`deploy-33.sh` 已删除：它写于通道断掉之后，从未被使用过，且被同批次的
`sync-files-local.sh` 取代（详见 `docs/pending-issues/50-*.md`）。

## 其他文件

- `Caddyfile` —— 反向代理与证书（见 `docs/deploy.md` 第 5 节）
- `audit-sources-flaky.sql` —— **只读**：间歇性慢源的信号、死源与摘要文案口径核对
  （issue #58）。每段开头标了该在迁移前还是迁移后跑：DROP COLUMN 之前要确认
  `schedule_config_json` 无人用过，删除死行之前要确认它名下 0 条目
- `cleanup-govcn-source.sql` —— **一次性写入**：删掉注册表已删适配器留下的 `govcn` 死行
  （issue #58）。删除条件把「名下 0 条目」写进 `WHERE` 当保险，情况有变就一行都不删
- `preflight-23.sh` / `verify-23-plumbing.sh` / `audit-data-23*.sql` —— 首次上线
  前的预检、链路核验与数据审计，同样是一次性脚本（同属历史留档）
