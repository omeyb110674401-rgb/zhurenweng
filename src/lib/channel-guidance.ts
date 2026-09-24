import { draftAvailability, type DraftAvailabilityInput } from './summary-display.ts';

/**
 * 「这一页为什么没有提交方式」的说明依据（issue #64）。
 *
 * 背景：`SubmissionChannels` 在取不到渠道时**整块不渲染**（issue #26 定的自律：绝不编一条
 * 「通常可通过邮件提出」凑数）。这条自律挡住了瞎编，却留下另一种不诚实：读者看到的是
 * 「这一页什么都没有」，而真相可能是三种完全不同的情况 ——
 * ① 本站根本没抓到这条的正文（只有公告壳）；② 抓到了正文但里面没有按常见句式写出的渠道；
 * ③ 渠道写在附件里，而附件读不出来。三者对读者的行动含义不同（②③该去原文与附件里找，
 * ①连原文正文都没有），页面却给出同一种沉默。
 *
 * 这一块因此只做一件事：**把"为什么空"说实话，并且不替原文编渠道**。
 * 判据只用仓库里已有的事实（正文长度、附件抽取报告），不引入新列、不猜。
 */

/** 附件侧能给的确信度：决定要不要把读者指向附件。 */
export type AttachmentHint = 'readable' | 'unreadable' | 'none' | 'unknown';

export interface ChannelGuidance {
  /** 为什么没有渠道：正文没抓到，还是正文里没有可识别的句式 */
  reason: 'no-body' | 'not-in-body';
  /** 抓到的正文字数（`not-in-body` 时页面会说出来） */
  bodyChars: number;
  attachment: AttachmentHint;
  /** 附件份数（`readable` / `unreadable` 时说得出数字） */
  attachmentFiles: number;
}

export function channelGuidance(input: {
  /** 页面上已经渲染出渠道清单（含摘要补充的那些） */
  hasChannels: boolean;
  bodyChars: number;
  /** 与「条文在哪」那句同源：`draftReport`（null = 抽取还没跑到这条，不是"没有附件"） */
  attachmentReport: DraftAvailabilityInput | null;
}): ChannelGuidance | null {
  if (input.hasChannels) return null;
  const draft = draftAvailability(input.attachmentReport);
  const attachment: AttachmentHint =
    draft.kind === 'read-and-used' || draft.kind === 'read-not-used'
      ? 'readable'
      : draft.kind === 'unreadable'
        ? 'unreadable'
        : draft.kind === 'no-attachments'
          ? 'none'
          : 'unknown';
  return {
    // 一个字都没抓到 ⇒ 不是"原文没写"，是"我们没拿到"。这两件事必须分开说。
    reason: input.bodyChars > 0 ? 'not-in-body' : 'no-body',
    bodyChars: input.bodyChars,
    attachment,
    attachmentFiles:
      draft.kind === 'read-and-used' || draft.kind === 'read-not-used' || draft.kind === 'unreadable'
        ? draft.files
        : 0,
  };
}
