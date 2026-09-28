import type { ReactNode } from 'react';
import { explanationCoverageVerdict } from '@/lib/explanation-coverage';

import { safeParseJson, type NoticeRecord } from '@/db/types';
import {
  IMPACT_KIND_LABELS,
  parseQuotedSummary,
  SUMMARY_STATUS_LABELS,
  type QuotedSummary,
  type SummarySection,
  type SummaryStatus,
} from '@/lib/summary-content';
import { draftAvailability, type DraftAvailabilityInput } from '@/lib/summary-display';
import { shouldRenderImpacts } from '@/lib/impact-display';
import { summaryProvenance, summaryTemplateOf } from '@/lib/summary-basis';

/**
 * 详情页摘要展示（issue #4 建立，issue #55/#56 重构为「参与导引」，issue #57 第 6 步
 * 重新启用条文要点）。
 *
 * 段落：这是什么 / 影响谁 / 谁能提 / 逾期会怎样 / **草案条文要点** / 截止日期 / 如何提意见。
 * 「条文要点」与其余各段不同：它的依据不是公告壳，而是本站从附件里抽出的正文，
 * 因此每条都带**出处**（哪个附件），且出处是程序按引用反查出来的（`buildQuotedSummary`）——
 * 反查不到的要点根本不会落库，所以这里不需要防御"模型编了条文"。
 * **渠道清单**仍刻意不在此渲染：地址在页面上只有一个位置，见下方 SummaryView 的注释。
 *
 * - done：渲染本体；可缺段（谁能提 / 逾期会怎样）文本为空时**整段不出现**，
 *   避免出现「标题下面没有内容」（issue #55 实测线上有过一条空的「影响谁」）。
 * - pending / failed_review：占位块（复用 data-testid="summary-placeholder" 契约），
 *   failed_review 额外标注「待人工复核」。
 * - 已截止且从未入队：「未生成摘要」说明块（issue #58）——「生成中」是对不会发生之事的
 *   承诺，这块把它换成实话，并把读者指向同一页上不依赖大模型的两块内容。
 * - 「AI 生成，仅供参考，以官方原文为准」标注在卡片头部显著位置（合规硬性要求）。
 * - 卡片底部说明条文在哪（`draftAvailability` 四分支）：读到了并用上了 / 读到了但本页
 *   未用 / 有附件但读不到 / 没有随文附件 —— 每一句都说的是**本页实际发生的事**。
 */

export const AI_DISCLAIMER_TEXT = 'AI 生成，仅供参考，以官方原文为准';

/**
 * 原文引用块：样式与摘要正文区分，点击打开出处。
 *
 * `href` 缺省是官方原文页；条文要点的引用则指向**该附件本身**（issue #57）——
 * 读者核对「这条要点是不是条文里写的」时，正确的落地页是那份 PDF/DOCX，
 * 而不是没有这些条文的公告页。
 */
function SectionQuote({
  notice,
  quote,
  href,
}: {
  notice: NoticeRecord;
  quote: string;
  href?: string;
}) {
  const target = href ?? notice.url;
  const isAttachment = target !== notice.url;
  return (
    <a
      className="summary-quote"
      href={target}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="summary-quote"
    >
      <span className="summary-quote-text">「{quote}」</span>
      <span className="summary-quote-jump">{isAttachment ? '查看附件↗' : '查看原文↗'}</span>
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
  attachmentReport,
}: {
  notice: NoticeRecord;
  summaryJson: string;
  summaryModel: string | null;
  /**
   * 附件条文的可读情况（issue #57 第 6 步）。未传 / null = 未探测过这份公示的附件
   * （该源不产附件，或抽取任务还没跑到），此时底部说明回到改动前的通用文案 ——
   * 没有事实就不说话，比猜一个分支诚实。
   */
  attachmentReport?: DraftAvailabilityInput | null;
}): ReactNode {
  const summary: QuotedSummary | null = parseQuotedSummary(safeParseJson(summaryJson));
  if (summary === null) {
    // 落库 JSON 形状异常（不应发生）：按待复核占位兜底，不让脏数据打断渲染
    return <SummaryPlaceholder status="failed_review" />;
  }

  const deadlineText = summary.deadline.text ?? notice.deadlineAt ?? '未标注';
  const draft = draftAvailability(attachmentReport ?? null);
  /**
   * 摘要依据（issue #83）：读者有权知道这份摘要是"读了随文条文写的"还是"只读了公告本身"。
   * 判据收在 `lib/summary-basis.ts` 一处（页面 / 后台 / 审计脚本共用），这里只负责渲染。
   *
   * 「附件条文要点」那一栏存在与否，与底部这行说明**必须同源**：曾经只要
   * `read-and-used` 就写"上方「草案条文要点」摘自…"，而名单 / 打包清单类的条目
   * 读了附件也产不出条文要点 —— 那行字于是指着一段不存在的栏位说话。
   */
  const hasClausePoints =
    summary.keyPoints.length > 0 || summary.explanationPoints.length > 0;
  /** 影响判读只对「公众广域」渲染（门控理由见上面那一块），底部那句说明要与它同源 */
  const hasImpacts = summary.impacts.length > 0 && notice.audience === 'public';
  const hasAttachmentPoints = hasClausePoints || hasImpacts;
  const provenance = summaryProvenance({
    attachment: attachmentReport ?? null,
    hasAttachmentPoints,
    template: summaryTemplateOf(safeParseJson(summaryJson)),
  });

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
        {/* 条文要点（issue #57 第 6 步）：依据是附件正文，不是公告壳，所以每条都带出处 */}
        {summary.keyPoints.length > 0 ? (
          <div className="summary-section" data-testid="summary-key-points">
            <h2 className="summary-section-title">草案条文要点</h2>
            <ul className="summary-points">
              {summary.keyPoints.map((point, index) => (
                <li key={index}>
                  <p className="summary-section-text">{point.text}</p>
                  {point.quote ? (
                    <SectionQuote
                      notice={notice}
                      quote={point.quote}
                      href={point.sourceUrl ?? undefined}
                    />
                  ) : null}
                  <p className="draft-point-source" data-testid="summary-draft-point-source">
                    {point.source
                      ? `出处：附件《${point.source}》（本站从附件逐字提取，未做改写）`
                      : '出处：未标注（本条摘要生成于附件出处核对上线之前）'}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/*
         * 「改动点」表格已于 2026-09-27 删除（issue #85）。
         *
         * 这一段曾经是修正案的正面回答：读者要知道"改了哪几处"，页面就列出条款、类型、
         * 一句话说明与逐字原文，并在上面给一行覆盖度（"正文里检测到 N 处，本页列出 M 处"）。
         *
         * **⚠️ 2026-09-27 更正：删它的判据是错的，见 `86-*.md` 第九节。** 当时写的是
         * "它从来没有产出过（5 条候选点名重跑后仍是 0 条）"，而实测是：那 5 条候选**从来没有
         * 被带这段代码的版本重跑过**（它们的摘要里连 `explanationPoints` 键都没有），
         * 用旧提示词重跑金丝雀**一次就吐出 10 条、8 条通过逐字反查** —— 两批不同的"5 条"
         * 被当成了一批。**是否恢复成单独一节由用户定**；本轮（#86 第 1 刀）先补的是
         * 它真正缺的那一半：影响判读（下面那一块）。
         *
         * 编制说明要点**留着**（下面那一块）：它在生产上真的渲染出来过（金丝雀 2 条）。
         */}

        {/*
         * 可能的争议点（issue #86 第 1 刀）—— 全站**唯一一段推断**内容。
         *
         * 为什么单独一块、为什么措辞这么小心：上面每一句都要求逐字对得上原文，而这里写的是
         * "这一条可能带来什么" —— 那是推断，**不可能逐字核对**。用户要的正是这个
         * （"吸毒修正案、留学生 Z 签都是事后曝光才有人参与"），所以不能不做，只能把它做成
         * 读者能自己判断的样子。三条硬规矩：
         * ① 每条挂一条**逐字原文**（反查不到整条不落库，出处由程序算，不由模型自报）；
         * ② **块级**免责声明 —— 卡片头部那行「AI 生成」说的是整张卡，而这一段是卡里唯一
         *    需要读者额外警惕的部分，它在自己的块里再讲一遍；
         * ③ **一行都没有时整块不渲染**（连标题都不出现）——#85 的教训：空壳比没有更坏。
         *
         * 位置：放在「草案条文要点」（短的、直接的证据）之后、「编制说明要点」（长尾）之前。
         * 这是有意的取舍 —— 证据先于推断（本站的立身之本），但又不能让读者翻过一整列说明
         * 才看到唯一会让他想提意见的东西。
         *
         * **受众面门控**：只给「公众广域」渲染（用户 2026-09-27 拍板："先只上公众广域 +
         * 人工过一遍"）。门放在**渲染侧**而不是生成侧：这一段与其余字段共用同一次模型调用，
         * 多写一份不额外花钱，而这批数据正是将来放宽档位时要用的原样原料。
         */}
        {(() => {
          const impacts = summary.impacts;
          // 判据在 lib/impact-display.ts（纯函数，能进单测也就能进自证框架 —— 页面 .tsx 两样都进不去）
          if (!shouldRenderImpacts({ audience: notice.audience, impacts })) return null;
          return (
            <div className="summary-section" data-testid="summary-impacts">
              <h2 className="summary-section-title">可能的争议点</h2>
              <p className="summary-section-note" data-testid="summary-impacts-note">
                以下是本站 AI 依据公开原文作出的<b>推断</b>，不是官方表述，也不构成法律意见；
                每条都附了它依据的那句原文，请自己判断。
              </p>
              <ul className="summary-points">
                {impacts.map((impact, index) => (
                  <li key={index}>
                    <p className="impact-kind" data-testid="summary-impact-kind">
                      {IMPACT_KIND_LABELS[impact.kind]}
                    </p>
                    <p className="summary-section-text">{impact.text}</p>
                    {impact.who ? (
                      <p className="impact-who" data-testid="summary-impact-who">
                        可能受影响：{impact.who}
                      </p>
                    ) : null}
                    <SectionQuote
                      notice={notice}
                      quote={impact.quote}
                      href={impact.sourceUrl ?? undefined}
                    />
                    <p className="draft-point-source" data-testid="summary-impact-source">
                      {impact.source
                        ? `出处：附件《${impact.source}》（本站从附件逐字提取，未做改写）`
                        : '出处：未标注（这条的引用没能反查到本轮喂入的附件）'}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        {(() => {
          /*
           * 编制说明要点（issue #76 第 3 刀）。
           *
           * 为什么单独一块而不是并进"条文要点"：说明是解释性文件，讲的是为什么制定、
           * 依据什么、主要改了什么、向谁征求意见；把它的句子标成"摘自官方原文的条文"
           * 就是让读者拿解释当规定读。所以这里按说明自己的小节列出，每条带出处，
           * 且引用反查只在说明类附件里做（见 buildQuotedSummary 的段落隔离）。
           */
          const points = summary.explanationPoints;
          if (points.length === 0) return null;
          return (
            <div className="summary-section" data-testid="summary-explanations">
              <h2 className="summary-section-title">编制说明要点</h2>
              {summary.explanationSections !== null ? (
                <p className="summary-section-note" data-testid="summary-explanation-coverage">
                  {explanationCoverageVerdict(points.length, summary.explanationSections).detail}
                </p>
              ) : null}
              <ul className="summary-points">
                {points.map((point, index) => (
                  <li key={index}>
                    {point.heading ? (
                      <p className="explanation-heading" data-testid="summary-explanation-heading">
                        {point.heading}
                      </p>
                    ) : null}
                    <p className="summary-section-text">{point.text}</p>
                    <SectionQuote notice={notice} quote={point.quote} href={point.sourceUrl ?? undefined} />
                    <p className="draft-point-source" data-testid="summary-explanation-source">
                      {point.source
                        ? `出处：说明附件《${point.source}》（本站从附件逐字提取，未做改写）`
                        : '出处：未标注（这条的引用没能反查到本轮喂入的说明）'}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

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
        {/*
          依据标签（issue #83）：这行是**分类本身**，下面那句是它的展开说明。
          读者扫一眼标签就知道这份摘要的输入是什么；`data-basis` 让审计与测试
          不必去解析中文（分类的单一来源是 lib/summary-basis.ts）。
        */}
        <span
          className={`summary-basis summary-basis-${provenance.basis}`}
          data-testid="summary-basis"
          data-basis={provenance.basis}
        >
          摘要依据：{provenance.label}
        </span>
        {draft.kind === 'read-and-used' ? (
          hasClausePoints ? (
            <>
              上方「草案条文要点」摘自<b>本站从随文附件里逐字读取的条文</b>（{draft.files} 份 /
              约 {draft.chars} 字），条文本身以下方附件与官方原文为准。
            </>
          ) : hasImpacts ? (
            <>
              上方「可能的争议点」所依据的原文，摘自<b>本站从随文附件里逐字读取的正文</b>
              （{draft.files} 份 / 约 {draft.chars} 字）；那一段是本站的推断，
              条文本身以下方附件与官方原文为准。
            </>
          ) : (
            <>
              本站已从随文附件里读取到条文（{draft.files} 份 / 约 {draft.chars} 字），
              但这份公告属名单 / 打包清单一类，<b>没有可逐条摘录的条文</b>；
              上面几段只依据公告本身，具体内容请看下方附件清单或官方原文页面。
            </>
          )
        ) : draft.kind === 'read-not-used' ? (
          <>
            本站已能读取随文附件的草案条文（{draft.files} 份），<b>本页摘要未使用这些条文</b>；
            具体规定请看下方附件清单或官方原文页面。
          </>
        ) : draft.kind === 'unreadable' ? (
          <>
            这份公示有 {draft.files} 份随文附件，但<b>本站未能读取其中的条文</b>
            （源站拒绝访问，或该格式暂不支持解析）。请直接下载附件，或到官方原文页面查看。
          </>
        ) : draft.kind === 'no-attachments' ? (
          <>
            本站索引的是公告本身；这份公示<b>没有随文附件</b>，
            具体条文与完整内容以官方原文页面为准。
          </>
        ) : (
          <>
            本站索引的是公告本身；草案全文、标准文本与名单等<b>具体条文在官方附件里</b>，
            请从下方附件清单或官方原文页面获取。
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

/**
 * 已截止、且不会再生成摘要（issue #58）：本站只为公示期内的条目生成摘要。
 * 标签刻意用「未生成」而不是「生成中」—— 后者承诺一件不会发生的事。
 */
export function SummaryNotGenerated(): ReactNode {
  return (
    <section className="summary-slot" data-testid="summary-not-generated">
      <div className="summary-head">
        <span className="summary-tag">AI 摘要</span>
        <span className="summary-pending" data-testid="summary-not-generated-label">
          未生成摘要
        </span>
      </div>
      <p className="summary-note">
        本条公示已截止，本站的 AI 结构化解读只覆盖公示期内的条目，因此这一条没有摘要，也不会再补生成。
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
