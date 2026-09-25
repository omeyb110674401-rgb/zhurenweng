#!/usr/bin/env node
/**
 * 备份失败的邮件出口（issue #71）。
 *
 * 为什么需要它：`deploy/daily-backup.sh` 由 cron 每天跑一次，失败时**非零退出并把输出写进
 * `/var/log/zhurenweng-backup.log`** —— 而没有人会去读那个文件。issue #68 已经证明过一次：
 * "配置在、进程在、脚本会退出"不等于"出事时有人知道"（那条 cron 整整一天没触发，
 * 唯一的暴露方式是产物不存在，而没人看产物）。备份恰好是最不能静默失败的东西。
 *
 * 所以失败要发信。刻意**复用 worker 那套告警出口** `sendTaskFailureAlert()` 而不是新写一个：
 * 它已经处理了「未配置 ALERT_EMAIL 就跳过」「按 日历日 × 任务名 × 源 去重」「自身绝不抛」
 * 这三件事，而"备份连续失败三天"应当只发一封、不该把站长邮箱刷成刷屏。
 * `sourceId` 传 null：备份不是某个抓取源的故障，塞一个假源 ID 会让邮件里出现
 * 「源：postgres-db（未在源登记表）」这种误导话。
 *
 * **退出码永远是 0**（除非 node 自己都起不来）：本脚本是"报错时的第二只手"，
 * 它自己失败不能把备份的原始退出码盖掉 —— 否则 cron 日志里看到的是"告警脚本挂了"，
 * 而真正该知道的"备份没做成"被换掉了。
 *
 * 用法（由 daily-backup.sh 的 ERR trap 调用，在部署了本仓库的容器里）：
 *   docker compose run --rm worker node scripts/alert-backup-failure.mjs "<失败原因>"
 */
import { sendTaskFailureAlert } from '../src/lib/alerts.ts';

const reason = process.argv.slice(2).join(' ').trim();
const error = reason === '' ? 'daily-backup.sh 失败，但未给出原因（检查 trap 是否被绕过）' : reason;

try {
  const sent = await sendTaskFailureAlert({
    jobName: 'daily-backup',
    sourceId: null,
    error: error.slice(0, 500),
    now: new Date(),
    log: (line) => console.log(`[alert-backup] ${line}`),
  });
  console.log(
    sent
      ? '[alert-backup] 备份失败告警已送出'
      : '[alert-backup] 未送出（未配置 ALERT_EMAIL / 当日已发过 / 邮件本身失败 —— 上面一行有原因）',
  );
} catch (inbound) {
  // sendTaskFailureAlert 设计上不抛；真抛了说明有缺陷，也只能打一行日志了事
  console.log(`[alert-backup] 发信路径异常（忽略，不改备份的退出码）：${String(inbound)}`);
}

process.exit(0);
