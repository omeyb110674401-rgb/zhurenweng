/**
 * 展示用有效状态（issue #43）。
 *
 * 状态列是**抓取时**推导的，而抓取每日一轮（生产 WORKER_INTERVAL_MS=86400000，
 * 实测上一轮 14:05 北京时间）：北京时间 00:00 到下一轮抓取之间（约 14 小时），
 * 刚过截止的条目在库里仍是 `open`。页面于是同时出现两个错误信号 ——
 * 徽标写「征求意见中」，而倒计时因为 `daysUntil < 0` **静默消失**（不是显示
 * 「已截止」，是什么都不显示），旁边的按钮还在邀请读者「去官方渠道提意见」。
 * 生产实测：今天（北京 2026-09-21）到期的 6 条，今晚 00:00 起就会这样挂到明天下午。
 *
 * 口径（只复核需要复核的那一档）：
 * - `resulted`（已出结果）以库内为准 —— 那是源站标注的结果状态，日期推不出来；
 * - `closed` 同理（源站可能提前结束征集，比日期更权威）；
 * - 只有 `open` 需要按当前日期再判一次：截止日已过 → 已截止。
 *
 * 只用于**展示**（徽标 / 摘要 / 结构化数据）。聚合与排序仍按库内 status 列 ——
 * 那是抓取口径（首页把 open 排在前面、统计页不做状态分布、提醒任务只认 d7/d3），
 * 改它们要先定产品口径；而读者看到的「这一条还能不能提意见」必须当场是对的。
 */

import type { NoticeRecord, NoticeStatus } from '../db/types.ts';
import { daysUntil } from './dates.ts';

/** 库内状态 + 截止日期 → 展示用有效状态。 */
export function effectiveStatus(
  notice: Pick<NoticeRecord, 'status' | 'deadlineAt'>,
  now: Date,
): NoticeStatus {
  if (notice.status !== 'open') return notice.status;
  const days = daysUntil(notice.deadlineAt, now);
  return days !== null && days < 0 ? 'closed' : 'open';
}
