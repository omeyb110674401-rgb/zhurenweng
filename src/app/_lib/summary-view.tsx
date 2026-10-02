import type { ReactNode } from 'react';
import { explanationCoverageVerdict } from '@/lib/explanation-coverage';
import {
  CHANGE_KIND_LABELS,
  changeCoverageVerdict,
  changeFactNote,
  changeTableNote,
} from '@/lib/change-coverage';
import { changeTableCounts, changeTableRows } from '@/lib/change-table';

import { safeParseJson, type NoticeRecord } from '@/db/types';
import {
  IMPACT_KIND_LABELS,
  parseQuotedSummary,
  SUMMARY_STATUS_LABELS,
  type QuotedSummary,
  type SummarySection,
  type SummaryStatus,
} from '@/lib/summary-content';
import { BODY_DRAFT_LABEL, type FeedReport } from '@/lib/attachment-feed';
import {
  draftAvailability,
  draftProvenanceLine,
  type DraftAvailabilityInput,
} from '@/lib/summary-display';
import { impactLine, impactOverview, shouldRenderImpacts, shouldRenderWho } from '@/lib/impact-display';
import { summaryProvenance, summaryTemplateOf } from '@/lib/summary-basis';

/**
 * 详情页摘要展示（issue #4 建立，issue #55/#56 重构为「参与导引」，issue #57 第 6 步
 * 重新启用条文要点）。
 *
 * 段落顺序（2026-10-02 两栏版式这一刀，规格第四节 —— **顺序本身是决定，别重排**）：
 * 这是什么 / 影响谁（仅行业专业档）/ **可能的争议点** / 草案条文要点 / 改了哪几处 /
 * 编制说明要点 / 逾期会怎样 / 截止日期 / 如何提意见，底部是出处 / 摘要依据 / 模型名。
 *
 * 两处位置是有意为之：
 * - **判读上移到「这是什么」之后**（原位置在「改了哪几处」之后）。它是这一段里唯一
 *   "会让读者想提意见"的东西，而下面几块是证据与长尾；让读者翻过一整列说明才看到它，
 *   等于把最该被看见的一段藏起来。证据先于推断这条原则没有让步 —— 判读块里每条推断
 *   仍与它依据的那句原文同屏。
 * - **「谁能提」整段不再渲染**（2026-10-02 用户拍板，规格第一节第 5 条）。删它的理由在
 *   数据里：96 条摘要里 95 条的取值等价于"公众可提"、平均 10.4 字、28% 干脆是空的 ——
 *   它复述的是"这是一份征求意见稿"这个**读者点进来之前就知道**的事实。这一刀先把渲染删掉，
 *   随后字段本身也一并删除（提示词 / 形状解析 / 落库 / 检索 / 后台表单，2026-10-02）——
 *   所以本组件里已经没有任何地方读它；旧行里多出来的那个键由 `parseQuotedSummary` 丢弃。
 *
 * 「条文要点」与其余各段不同：它的依据不是公告壳，而是本站从附件里抽出的正文，
 * 因此每条都带**出处**（哪个附件），且出处是程序按引用反查出来的（`buildQuotedSummary`）——
 * 反查不到的要点根本不会落库，所以这里不需要防御"模型编了条文"。
 * **渠道清单**仍刻意不在此渲染：地址在页面上只有一个位置，见下方 SummaryView 的注释。
 *
 * - done：渲染本体；可缺段（影响谁 / 逾期会怎样）文本为空时**整段不出现**，
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
  feedReport,
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
  /**
   * 产出这份摘要的那次调用喂进去了什么（issue #86 §19.4 的收尾）。两处覆盖度文案
   * （「改了哪几处」的表与「编制说明要点」）靠它说清差额能归给谁：清单报了截断才允许提
   * "没喂进去的那一截"，没报就只归给模型没写，没有清单（v1 的存量行）照实说说不清。
   * 判据全在 `.ts` 里（页面只传参）：这个文件进不了单测，而那句话正是这一刀要修的东西。
   */
  feedReport?: FeedReport | null;
}): ReactNode {
  const summary: QuotedSummary | null = parseQuotedSummary(safeParseJson(summaryJson));
  if (summary === null) {
    // 落库 JSON 形状异常（不应发生）：按待复核占位兜底，不让脏数据打断渲染
    return <SummaryPlaceholder status="failed_review" />;
  }

  const deadlineText = summary.deadline.text ?? notice.deadlineAt ?? '未标注';
  /**
   * 条文来自**本页正文**吗（issue #86 第十六节）：判据是"摘要里有没有出处 = 本页正文的内容"。
   * 从摘要自己推、不加新列 —— 与 `summaryTemplateOf` 用"键在不在"同一条路数。
   * 少了这一句，页面会一边说「没有随文附件」一边印着条文要点与出处。
   */
  const bodyDraft =
    summary.keyPoints.some((point) => point.source === BODY_DRAFT_LABEL) ||
    summary.impacts.some((point) => point.source === BODY_DRAFT_LABEL) ||
    summary.changes.some((point) => point.source === BODY_DRAFT_LABEL);
  const draft = draftAvailability(
    attachmentReport ? { ...attachmentReport, bodyDraft } : null,
  );
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
  /** 「改了哪几处」不设受众面门控：它是**事实**（每行都挂着可核对的原文），不是推断 */
  const hasChanges = summary.changes.length > 0;
  const hasAttachmentPoints = hasClausePoints || hasImpacts || hasChanges;
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
        {/*
         * 「影响谁」（2026-10-02 两栏版式这一刀）：**只在行业专业档渲染**，判据在
         * `lib/impact-display.ts` 的 `shouldRenderWho`（页面 .tsx 进不了单测，而钉不住的
         * 判据等于没有判据 —— 见那个文件的头注）。
         *
         * 这一段与「可能的争议点」的门控**方向相反**，两处挨着看才不容易改错：
         * 公众广域看的是判读（推断），行业专业看的是受影响主体（那一档里它就是读者自己）。
         * 空串同样整段不渲染 —— 连标题都不出现（#55 / #85 的教训）。
         */}
        {shouldRenderWho({ audience: notice.audience, who: summary.who }) ? (
          <SectionBlock notice={notice} label="影响谁" section={summary.who} testId="summary-who" />
        ) : null}
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
         * 位置（2026-10-02 两栏版式这一刀）：**「这是什么」之后、「草案条文要点」之前**。
         * 原先它在「改了哪几处」之后，理由写的是"证据先于推断"；那一刀之后证据并没有被推到
         * 后面去（条文要点、改动表、编制说明仍在它下面），而它自己上移到了读者第一屏 ——
         * 规格第一节第 7 条拍板的就是这件事。
         *
         * 块内渲染在**同日第二刀**（「影响点」三件，规格第七节）改了两处：块首多了两行概览
         * （计数 + 主体，程序聚合）、每条那行「可能受影响：<长串>」换成 `impactLine` 判出来的
         * 「影响：主体 · 方面」。两处的**措辞与空值判据都在 `lib/impact-display.ts`**，
         * 这里只负责摆放与"null 就不渲染"（页面 .tsx 进不了单测，拼接写在这里等于钉不住）。
         *
         * **受众面门控**：只给「公众广域」渲染（用户 2026-09-27 拍板："先只上公众广域 +
         * 人工过一遍"）。门放在**渲染侧**而不是生成侧：这一段与其余字段共用同一次模型调用，
         * 多写一份不额外花钱，而这批数据正是将来放宽档位时要用的原样原料。
         */}
        {(() => {
          const impacts = summary.impacts;
          // 判据在 lib/impact-display.ts（纯函数，能进单测也就能进自证框架 —— 页面 .tsx 两样都进不去）
          if (!shouldRenderImpacts({ audience: notice.audience, impacts })) return null;
          /*
           * 块首概览（2026-10-02 第二刀「影响点」三件之一，规格 7.5）：计数行 + 主体行，
           * 两行都是**程序聚合**的（不额外调模型），因此措辞全部落在 `impactOverview` 里 ——
           * 页面一个字都不拼。页面里的字符串拼接进不了单测、也进不了自证框架的钉子，
           * 而这两行**没有模型兜底**：这里写错，页面上就是错的。
           *
           * 位置在免责声明**之后**：先让读者读到"这是推断"，再给他索引 ——
           * 顺序反过来等于把一句没有证据地位的汇总摆在免责声明前面。
           */
          const overview = impactOverview(impacts);
          return (
            <div className="summary-section" data-testid="summary-impacts">
              <h2 className="summary-section-title">可能的争议点</h2>
              <p className="summary-section-note" data-testid="summary-impacts-note">
                以下是本站 AI 依据公开原文作出的<b>推断</b>，不是官方表述，也不构成法律意见；
                每条都附了它依据的那句原文，请自己判断。
              </p>
              {/*
                概览行与主体行是**两个独立元素**（不是一个 `<p>` 里两句话）：
                主体行可能整个不出现（一条判读都没写出主体时），而计数行永远在
                （这一段有"一条都没有就整块不渲染"的门，走到这里 `countsLine` 必不为 null）。
              */}
              <p className="impact-overview" data-testid="summary-impacts-overview">
                {overview.countsLine}
              </p>
              {overview.whoLine !== null ? (
                <p className="impact-overview-who" data-testid="summary-impacts-overview-who">
                  {overview.whoLine}
                </p>
              ) : null}
              <ul className="summary-points">
                {impacts.map((impact, index) => {
                  /*
                   * 这一条那一行「影响：主体 · 方面」（第二刀三件之二）：写什么、以及
                   * **什么时候整行不渲染**（`null`），判据都在 `impactLine` 里。
                   * 旧实现判的是 `impact.who ?` —— 换成新形状之后，"有方面没主体"的那条
                   * 会被整行吞掉，所以这一行必须由判据说了算。
                   */
                  const line = impactLine(impact);
                  return (
                    <li key={index}>
                      <p className="impact-kind" data-testid="summary-impact-kind">
                        {IMPACT_KIND_LABELS[impact.kind]}
                      </p>
                      <p className="summary-section-text">{impact.text}</p>
                      {line !== null ? (
                        <p className="impact-who" data-testid="summary-impact-who">
                          {line}
                        </p>
                      ) : null}
                      <SectionQuote
                        notice={notice}
                        quote={impact.quote}
                        href={impact.sourceUrl ?? undefined}
                      />
                      <p className="draft-point-source" data-testid="summary-impact-source">
                        {impact.source
                          ? draftProvenanceLine(
                              impact.source,
                              '出处：未标注（这条的引用没能反查到本轮喂入的附件）',
                            )
                          : '出处：未标注（这条的引用没能反查到本轮喂入的附件）'}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })()}
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
                    {draftProvenanceLine(
                      point.source,
                      '出处：未标注（本条摘要生成于附件出处核对上线之前）',
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/*
         * 「改了哪几处」（issue #86 第 2 刀）—— 这一段是**重建**，不是新功能。
         *
         * 同样的内容 #76 实现过、上过线，2026-09-27 被整体删除（issue #85），判据是
         * "它从来没有产出过"。**那个判据是错的**（86-*.md 第九节）：那 5 条候选从来没有被带
         * 这段代码的版本重跑过（两批不同的"5 条"被当成了一批），用旧提示词重跑金丝雀**一次
         * 就吐出 10 条、8 条通过逐字反查**。所以它回来了，但**地基换了三处**：
         * ① 引用可以在**任何一份**喂进去的附件里反查（旧实现只认条文侧，而实测显示法律修正
         *    草案的对照句在正文、住建部那批在编制说明 —— 只认一侧白丢一半）；
         * ② **不再按体裁门控**（`genre !== 'amendment'` 那道门是 #79 那个空栏的成因之一），
         *    改判据为"有没有可核对的依据"：一行都没反查到就整块不渲染；
         * ③ 校验器容忍省略号（实验量到 20% 的产出丢在那儿）。
         *
         * 最后一列是**逐字原文**，与左边的说明同屏 —— 说明本身不可核对（那是模型对着原句
         * 写的一句话），所以绝不让它脱离原文单独成立。
         *
         * **2026-09-28 第二十节第 3 小节：行改由程序定。** 上面这套地基有一处漏洞是实测出来的
         * （§19.3）：表里只有模型写出来的行，同一份输入跑四遍是 8 / 2 / 3 / 8 行，而读者
         * **看不出少了** —— 覆盖度那行只说"检测到 14 处、列出 2 处"，没有任何办法把缺的找出来。
         * 现在按句（官方那串"一、二、三…"的条目）归并：每一句一行，模型写得出可核对说明的
         * 照旧渲染，写不出的那一行只报「本站检测到这一处改动表述，但没能给出可核对的说明」，
         * 标题句（不含条款内容、下面挂着子条目）不单独成行。抖动于是从"表少了一半"（不可见）
         * 变成"某几行的说明暂时缺着"（可见）。判据在 `lib/change-table.ts`，页面只按下标取。
         */}
        {(() => {
          const changes = summary.changes;
          const table = summary.changeTable;
          if (changes.length === 0 && table === null) return null;
          /**
           * 表里的行由**程序**定（`summary.changeTable`，见 lib/change-table.ts）；没有这张表
           * 的老行退回旧样子：只列模型写出的那几行。判据与验收脚本共用 `changeTableRows`。
           */
          const entries = changeTableRows(changes, table);
          const { described, factOnly } = changeTableCounts(entries);
          const note =
            table !== null && summary.changeMarkers
              ? changeTableNote(
                  {
                    markers: summary.changeMarkers.total,
                    rows: entries.length,
                    described,
                    factOnly,
                    headers: table.headers,
                  },
                  feedReport,
                ).detail
              : summary.changeMarkers
                ? changeCoverageVerdict(changes.length, summary.changeMarkers, feedReport).detail
                : null;
          return (
            <div className="summary-section" data-testid="summary-changes">
              <h2 className="summary-section-title">改了哪几处</h2>
              {note ? (
                <p className="summary-section-note" data-testid="summary-change-coverage">
                  {note}
                </p>
              ) : null}
              <div
                className="stat-table-wrap"
                role="region"
                tabIndex={0}
                aria-label="改动点表（窄屏可横向滚动）"
              >
                <table className="stat-table" data-testid="summary-change-table">
                  <thead>
                    <tr>
                      <th scope="col">条款</th>
                      <th scope="col">类型</th>
                      <th scope="col">改了什么</th>
                      <th scope="col">原文（本站逐字摘录）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, index) => {
                      if (entry.type === 'fact') {
                        /*
                         * 只报事实的那一行（issue #86 第二十节第 3 小节）：程序在这一句里数到了
                         * 改动表述，但模型没写出可核对的说明（或那一行没通过逐字反查）。
                         * 这一行的**存在本身**就是交代 —— 从前的表里它整个不存在，读者看不出少了。
                         * 「改了什么」那一格照实说"没能给出说明"，绝不拿原句去冒充说明。
                         */
                        return (
                          <tr key={index} data-testid="summary-change-row-fact">
                            <th scope="row">{entry.clause === '' ? '—' : entry.clause}</th>
                            <td>
                              {entry.kinds.length > 0
                                ? entry.kinds.map((kind) => CHANGE_KIND_LABELS[kind]).join('、')
                                : '—'}
                            </td>
                            <td data-testid="summary-change-fact-note">
                              {/* 措辞在 lib/change-coverage.ts 的 changeFactNote 里（页面与验收门共用一份） */}
                              {changeFactNote(entry)}
                            </td>
                            <td>
                              <p>{entry.sentence}</p>
                            </td>
                          </tr>
                        );
                      }
                      const change = changes[entry.change];
                      // 下标越界（理论上不该有）：宁可少一行，也不能印一行空白
                      if (!change) return null;
                      return (
                        <tr key={index} data-testid="summary-change-row-described">
                          {/* 原文没写条号时留一个破折号，而不是空着 —— 空格子看起来像渲染坏了 */}
                          <th scope="row">{change.clause === '' ? '—' : change.clause}</th>
                          <td>{CHANGE_KIND_LABELS[change.kind]}</td>
                          <td>{change.text}</td>
                          <td>
                            <p>{change.quote}</p>
                            <p className="draft-point-source" data-testid="summary-change-source">
                              {change.source
                                ? draftProvenanceLine(
                                    change.source,
                                    '出处：未标注（这条的引用没能反查到本轮喂入的附件）',
                                  )
                                : '出处：未标注（这条的引用没能反查到本轮喂入的附件）'}
                            </p>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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
                  {/* 与「改了哪几处」那一栏同一份判据（issue #86 §19.4 收尾）：差额能归给谁，
                      由喂入清单说了算 —— 只改一处会让读者以为两栏的可信度不同 */}
                  {explanationCoverageVerdict(
                    points.length,
                    summary.explanationSections,
                    feedReport,
                  ).detail}
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
        {draft.kind === 'body-draft' ? (
          // 条文在本页正文里（issue #86 第十六节）：说清"没有附件"与"我们读了什么"两件事。
          // 这一支必须排在最前 —— 它的附件行数通常是 0，落到下面那一支就会写出
          // 「没有随文附件」与上方条文要点互相打架的话。
          hasClausePoints || hasChanges || hasImpacts ? (
            <>
              这份公示<b>没有随文附件</b>：草案全文就印在本页正文里，本站已逐字读取并据此写出上面的内容
              {draft.files > 0 ? `（另挂着 ${draft.files} 份附件）` : ''}；条文本身以官方原文页面为准。
            </>
          ) : (
            <>
              这份公示<b>没有随文附件</b>：草案全文在本页正文里，本站读了，但这份公告没有可逐条摘录的内容；
              上面几段只依据公告本身，完整内容以官方原文页面为准。
            </>
          )
        ) : draft.kind === 'read-and-used' ? (
          hasClausePoints ? (
            <>
              上方「草案条文要点」摘自<b>本站从随文附件里逐字读取的条文</b>（{draft.files} 份 /
              约 {draft.chars} 字），条文本身以下方附件与官方原文为准。
            </>
          ) : hasChanges ? (
            <>
              上方「改了哪几处」表格里的原文，摘自<b>本站从随文附件里逐字读取的正文</b>
              （{draft.files} 份 / 约 {draft.chars} 字）；条文本身以下方附件与官方原文为准。
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
        本站正在为本条公示生成结构化 AI 摘要（这是什么 / 可能的影响 / 草案条文要点 / 如何提意见）；
        抽到的提交地址会并入下方「意见提交方式」，并标注为「摘要补充」。
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
