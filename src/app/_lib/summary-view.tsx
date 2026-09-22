import type { ReactNode } from 'react';
import { safeParseJson, type NoticeRecord } from '@/db/types';
import {
  parseQuotedSummary,
  SUMMARY_STATUS_LABELS,
  type QuotedSummary,
  type SummarySection,
  type SummaryStatus,
} from '@/lib/summary-content';

/**
 * 详情页摘要展示（issue #4 建立，issue #55/#56 重构为「参与导引」）。
 *
 * 段落：这是什么 / 影响谁 / 谁能提 / 逾期会怎样 / 截止日期 / 如何提意见。
 * 两处刻意不在此渲染：**关键条款**（抓取到的正文是公告壳，生产实测均值 443 字，
 * 草案条文在附件里，从壳里概括只会产出看着像条款的元信息复述）与**渠道清单**
 * （地址在页面上只有一个位置，见下方 SummaryView 的注释）。
 * `keyPoints` 仍保留渲染通路，供存量摘要在重刷完成前正常显示（不是给新输出用的）。
 *
 * - done：渲染本体；可缺段（谁能提 / 逾期会怎样）文本为空时**整段不出现**，
 *   避免出现「标题下面没有内容」（issue #55 实测线上有过一条空的「影响谁」）。
 * - pending / failed_review：占位块（复用 data-testid="summary-placeholder" 契约），
 *   failed_review 额外标注「待人工复核」。
 * - 「AI 生成，仅供参考，以官方原文为准」标注在卡片头部显著位置（合规硬性要求）。
 * - 卡片底部明写条文在哪：附件与官方原文 —— 这是本次重构的落脚点，
 *   与其让摘要装作总结了条文，不如把读者准确地送到条文所在。
 */

export const AI_DISCLAIMER_TEXT = 'AI 生成，仅供参考，以官方原文为准';

/** 原文引用块：样式与摘要正文区分，点击打开官方原文。 */
function SectionQuote({ notice, quote }: { notice: NoticeRecord; quote: string }) {
  return (
    <a
      className="summary-quote"
      href={notice.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="summary-quote"
    >
      <span className="summary-quote-text">「{quote}」</span>
      <span className="summary-quote-jump">查看原文↗</span>
    </a>
  );
}

/**
 * 一段摘要（标题 + 正文 + 可选引用）。
 *
 * 标题用 h2 而非 h3（issue #53）：详情页的标题层级是 h1（条目标题）→ 这里的各段，
 * 中间没有 h2，跳级会让读屏的标题导航缺一层。样式走 .summary-section-title。
 */
function SectionBlock({
  notice,
  label,
  section,
  testId,
  children,
}: {
  notice: NoticeRecord;
  label: string;
  section: SummarySection;
  testId: string;
  children?: ReactNode;
}) {
  if (section.text.trim() === '') return null;
  return (
    <div className="summary-section" data-testid={testId}>
      <h2 className="summary-section-title">{label}</h2>
      <p className="summary-section-text">{children ?? section.text}</p>
      {section.quote ? <SectionQuote notice={notice} quote={section.quote} /> : null}
    </div>
  );
}

/**
 * 已生成摘要视图。调用方保证 summary 已通过 parseQuotedSummary 校验；
 * 模型名（notices.summary_model）随标注一并展示，便于溯源。
 *
 * 这里**不渲染渠道清单**：地址在页面上只有一个位置，即「去官方渠道提意见」按钮旁的
 * 「意见提交方式」块（issue #56）。摘要抽到的渠道由 `mergeSubmissionChannels` 并入
 * 那份清单并标上「摘要补充」，而不是在这里再列一份 —— 同一个邮箱出现两遍、
 * 且两份出处不同，是读者最不需要看到的画面。
 */
export function SummaryView({
  notice,
  summaryJson,
  summaryModel,
}: {
  notice: NoticeRecord;
  summaryJson: string;
  summaryModel: string | null;
}): ReactNode {
  const summary: QuotedSummary | null = parseQuotedSummary(safeParseJson(summaryJson));
  if (summary === null) {
    // 落库 JSON 形状异常（不应发生）：按待复核占位兜底，不让脏数据打断渲染
    return <SummaryPlaceholder status="failed_review" />;
  }

  const deadlineText = summary.deadline.text ?? notice.deadlineAt ?? '未标注';

  return (
    <section className="summary-card" data-testid="ai-summary">
      <div className="summary-head">
        <span className="summary-tag">AI 摘要</span>
        <strong className="ai-disclaimer" data-testid="ai-disclaimer">
          {AI_DISCLAIMER_TEXT}
        </strong>
      </div>

      <div className="summary-sections">
        <SectionBlock notice={notice} label="这是什么" section={summary.what} testId="summary-what" />
        <SectionBlock notice={notice} label="影响谁" section={summary.who} testId="summary-who" />
        <SectionBlock
          notice={notice}
          label="谁能提"
          section={summary.whoCanSubmit}
          testId="summary-who-can-submit"
        />
        <SectionBlock
          notice={notice}
          label="逾期会怎样"
          section={summary.afterDeadline}
          testId="summary-after-deadline"
        />
        {/* 历史段：只可能在重刷完成前的存量摘要里出现 */}
        {summary.keyPoints.length > 0 ? (
          <div className="summary-section" data-testid="summary-key-points">
            <h2 className="summary-section-title">关键条款</h2>
            <ul className="summary-points">
              {summary.keyPoints.map((point, index) => (
                <li key={index}>
                  <p className="summary-section-text">{point.text}</p>
                  {point.quote ? <SectionQuote notice={notice} quote={point.quote} /> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <SectionBlock
          notice={notice}
          label="截止日期"
          section={{ text: deadlineText, quote: summary.deadline.quote }}
          testId="summary-deadline"
        />
        <SectionBlock
          notice={notice}
          label="如何提意见"
          section={summary.howToComment}
          testId="summary-how-to-comment"
        />
      </div>

      <p className="summary-sources" data-testid="summary-sources">
        {notice.attachments.length > 0 ? (
          <>
            本站索引的是公告本身；草案全文、标准文本与名单等<b>具体条文在官方附件里</b>，
            请从下方附件清单或官方原文页面获取。
          </>
        ) : (
          <>
            本站索引的是公告本身；这份公示<b>没有随文附件</b>，
            具体条文与完整内容以官方原文页面为准。
          </>
        )}
      </p>
      <p className="summary-model" data-testid="summary-model">
        摘要模型：{summaryModel ?? '未知'}；内容为机器生成，请以官方原文为准后参考使用。
      </p>
    </section>
  );
}

/**
 * AI 摘要未启用（issue #22 / #27）：LLM 端口未配置时替代「生成中」占位。
 *
 * 「生成中」是进行时承诺 —— 端口没配置时它永远不会兑现，对外显示等于骗人。
 * 这里如实说明，并把读者引向上方的「结构化速读」与「意见提交方式」（issue #27：
 * 那两块由程序从原文逐字摘录，不依赖大模型，因此本说明不再是死胡同）。
 */
export function SummaryUnavailable(): ReactNode {
  return (
    <section className="summary-slot" data-testid="summary-unavailable">
      <div className="summary-head">
        <span className="summary-tag">AI 摘要</span>
        <span className="summary-pending" data-testid="summary-unavailable-label">
          暂未启用
        </span>
      </div>
      <p className="summary-note">
        本站的 AI 结构化解读尚未启用（未配置大模型端口），本条不提供机器生成摘要。
        上方的「结构化速读」与「意见提交方式」由程序从官方原文逐字摘录、不依赖大模型；
        完整内容请以官方原文为准。
      </p>
    </section>
  );
}

/** 摘要占位：pending（生成中）与 failed_review（待人工复核）共用块结构。 */
export function SummaryPlaceholder({ status }: { status: SummaryStatus }): ReactNode {
  return (
    <section className="summary-slot" data-testid="summary-placeholder">
      <div className="summary-head">
        <span className="summary-tag">AI 摘要</span>
        <span className="summary-pending">{SUMMARY_STATUS_LABELS[status] ?? status}</span>
      </div>
      <p className="summary-note">
        本站正在为本条公示生成结构化 AI 摘要（这是什么 / 影响谁 / 谁能提 / 如何提意见）；抽到的
        提交地址会并入下方「意见提交方式」，并标注为「摘要补充」。
        AI 生成内容将显著标注并附原文引用，仅供参考，以官方原文为准。
      </p>
      {status === 'failed_review' ? (
        <p className="summary-review-note" data-testid="summary-review-note">
          自动生成多次失败，已转人工复核队列；复核通过前请直接阅读官方原文。
        </p>
      ) : null}
    </section>
  );
}
