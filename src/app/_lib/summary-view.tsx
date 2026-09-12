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
 * 详情页摘要展示（issue #4）：
 * - done：五段式结构化摘要（这是什么 / 影响谁 / 关键条款 / 截止日期 / 如何提意见），
 *   每段附原文引用片段，引用以区分样式展示并可点击跳转官方原文核对；
 * - pending / failed_review：占位块（复用 data-testid="summary-placeholder" 契约），
 *   failed_review 额外标注「待人工复核」；
 * - 「AI 生成，仅供参考，以官方原文为准」标注在卡片头部显著位置（合规硬性要求）。
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

function SummarySectionBlock({
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
  return (
    <div className="summary-section" data-testid={testId}>
      <h3 className="summary-section-title">{label}</h3>
      <p className="summary-section-text">{children ?? section.text}</p>
      {section.quote ? <SectionQuote notice={notice} quote={section.quote} /> : null}
    </div>
  );
}

/**
 * 已生成摘要视图。调用方保证 summary 已通过 parseQuotedSummary 校验；
 * 模型名（notices.summary_model）随标注一并展示，便于溯源。
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
        <SummarySectionBlock notice={notice} label="这是什么" section={summary.what} testId="summary-what" />
        <SummarySectionBlock notice={notice} label="影响谁" section={summary.who} testId="summary-who" />
        <div className="summary-section" data-testid="summary-key-points">
          <h3 className="summary-section-title">关键条款</h3>
          <ul className="summary-points">
            {summary.keyPoints.map((point, index) => (
              <li key={index}>
                <p className="summary-section-text">{point.text}</p>
                {point.quote ? <SectionQuote notice={notice} quote={point.quote} /> : null}
              </li>
            ))}
          </ul>
        </div>
        <SummarySectionBlock
          notice={notice}
          label="截止日期"
          section={{ text: deadlineText, quote: summary.deadline.quote }}
          testId="summary-deadline"
        />
        <SummarySectionBlock
          notice={notice}
          label="如何提意见"
          section={summary.howToComment}
          testId="summary-how-to-comment"
        />
      </div>

      <p className="summary-model" data-testid="summary-model">
        摘要模型：{summaryModel ?? '未知'}；内容为机器生成，请以官方原文为准后参考使用。
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
        <span className="summary-pending">{SUMMARY_STATUS_LABELS[status]}</span>
      </div>
      <p className="summary-note">
        本站正在为本条公示生成结构化 AI 摘要（这是什么 / 影响谁 / 关键条款 / 如何提意见）。
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

