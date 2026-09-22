/**
 * 附件条文功能的开关（issue #57）。
 *
 * 三个档位存在的理由：这件事会改变**用户看到的摘要内容**（条文要点回来了、「条文在哪」
 * 换文案），而它成不成取决于十个政府站点的行为 —— 我们没法在本地证明。所以先让它在
 * `shadow` 下跑一轮真实数据、出审计数，确认成功面之后再 `on`。
 *
 * - `off`：抽取与摘要两侧都不碰附件（回到 #57 之前的行为）；
 * - `shadow`：抽取照跑并写库（状态、文本都有），但摘要**不读**这些文本 —— 页面不变，
 *   生产验收脚本照样能出数；
 * - `on`：摘要读。
 *
 * 配置写错要当场说清楚（与 `envInt` 同一取舍）：`ATTACHMENT_TEX=on` 这种笔误如果静默
 * 当成 off，会得到「附件功能上线了但什么都没发生」的错误结论。
 */

export type AttachmentTextMode = 'off' | 'shadow' | 'on';

const MODES: readonly AttachmentTextMode[] = ['off', 'shadow', 'on'];

function rawMode(): AttachmentTextMode {
  // 空串要当「未设置」：compose 用 `${ATTACHMENT_TEXT:-}` 形态传变量，操作者留空就会传进来
  // 一个空字符串 —— 按严格判定它是个非法档位，于是「留空用缺省」变成「留空就崩」。
  const raw = process.env.ATTACHMENT_TEXT?.trim();
  const value = raw === undefined || raw === '' ? 'on' : raw.toLowerCase();
  if ((MODES as readonly string[]).includes(value)) return value as AttachmentTextMode;
  throw new Error(`ATTACHMENT_TEXT 不是合法档位：「${raw ?? ''}」（应为 off / shadow / on，未设置时缺省 on）`);
}

/** 抽取任务是否运行。 */
export function attachmentExtractionEnabled(): boolean {
  return rawMode() !== 'off';
}

/** 摘要是否可以把附件文本当输入（`shadow` 为 false，这正是它与 on 的唯一区别）。 */
export function attachmentTextFeedsSummary(): boolean {
  return rawMode() === 'on';
}

/** 当前档位，写进日志与审计输出。 */
export function attachmentMode(): AttachmentTextMode {
  return rawMode();
}
