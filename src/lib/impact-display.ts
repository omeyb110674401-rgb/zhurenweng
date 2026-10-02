import type { NoticeAudience } from './audience.ts';
import type { ImpactKind } from './ports.ts';
import { IMPACT_KIND_LABELS, type QuotedImpactPoint } from './summary-content.ts';

/**
 * 「给谁看」与「影响点怎么写」这件事的判据都收在这个文件里
 * （issue #86 第 1 刀建立，2026-10-02 两栏版式加第二族，同日第二刀加第三族）。
 *
 * **为什么判据必须抽成纯函数**：它与 #58 把「未生成摘要」的文案判据抽出来是同一条理由 ——
 * 页面组件（`.tsx`）进不了本仓库的单测（自证框架只认 `node --test` 直读 `.ts`），
 * 而**钉不住的判据等于没有判据**：`check-test-pins.mjs` 撤掉实现要能变红，
 * 撤 `.tsx` 里的分支是撤不出红的（e2e 跑的是 `.next` 构建产物）。
 * 所以"给谁看"这件事留在 `.ts` 里，"怎么画"才留给页面。
 *
 * 前两族判据在这里合住，因为它们是同一类决定、共用同一个入参（受众面），
 * 而**受众面的两个方向是相反的**：公众广域看推断、行业专业看受影响主体。
 * 分到两个文件里，下一个人改门控时只会看见一半。
 *
 * 第三族（`impactLine` / `impactOverview`，「影响点」三件的展示侧）入参不是受众面而是
 * 判读本身，放在这里是因为它判的是**同一段渲染**（「可能的争议点」）的另外两件事：
 * 每条那一行写什么、块首那行概览写什么。措辞一旦落到 `.tsx` 里就再也钉不住 ——
 * 而这两行是**程序聚合**出来的（不额外调模型），也就是说：**这里的字符串就是产品本身**，
 * 没有模型兜底，写错了页面上就是错的。所以它们与门控一样必须待在能进单测的 `.ts` 里。
 */

/**
 * 「可能的争议点」该不该渲染（issue #86 第 1 刀）。
 *
 * 两条判据，缺一不可：
 * - **受众面**：用户 2026-09-27 拍板"先只上公众广域 + 人工过一遍"。判读说错的代价不是
 *   "不准确"而是"误导公众"，所以第一版只给最该看见它的那一档。未判定（`null` / `unknown`）
 *   同样不渲染 —— 判不出来就不给它加码。
 * - **非空**：一条都没有时整块不出现，连标题都不出现。空壳比没有更坏（#85 的教训：
 *   一个写着标题、内容却空着的栏目，读者读到的是"这一栏没东西可看"）。
 */
export function shouldRenderImpacts(input: {
  audience: NoticeAudience | null;
  impacts: QuotedImpactPoint[];
}): boolean {
  return input.audience === 'public' && input.impacts.length > 0;
}

/**
 * 「影响谁」该不该渲染（2026-10-02 两栏版式这一刀，规格第四节）。
 *
 * **只在行业专业档渲染**，与「可能的争议点」正好相反 —— 这是用户拍板的取舍，理由是
 * 两段话的证据地位不同：
 * - 「影响谁」是 L1 事实段，而实测（`.git/zw-who-echo.mjs`，只读探针）显示它对公众广域
 *   条目基本是**标题复述**："笼统地将征求意见的公示名称加上其对应的行业或主体"
 *   （用户 2026-10-02 的原话）。一句从标题抄来的话占着摘要卡第二段的位置，读者读到的是
 *   一条看起来像结论、其实没有信息量的句子。
 * - 而**行业专业**条目里，受影响主体就是读者自己那一行（运输机场运营人 / 医疗器械注册人），
 *   这句话是"这跟我有没有关系"的直接答案，正是它最有用的一档。
 *
 * "谁受影响"的深度由 L3 判读承担（每条判读自带的「可能受影响」），L1 这一段**不加深** ——
 * 那是第二刀的事，本刀只把渲染面收窄到它真正成立的那一档。
 *
 * **空串整段不渲染**（连标题都不出现）：判据是 `who` 文本非空，而不是"这一档该不该有"。
 * 这与 #55/#85 的教训同源 —— 一个写着标题、下面空着的栏目比没有更坏（线上真出现过
 * 一条空的「影响谁」）。
 *
 * 未判定（`null` / `unknown`）同样不渲染：判不出来就不给它加码，与 `shouldRenderImpacts` 同规矩。
 */
export function shouldRenderWho(input: {
  audience: NoticeAudience | null;
  who: { text: string } | null | undefined;
}): boolean {
  if (input.audience !== 'sector') return false;
  return (input.who?.text ?? '').trim() !== '';
}

/**
 * 块首概览里最多列几个主体（`topWho`）。
 *
 * 为什么是个**具名常量**而不是散在函数里的字面量：这个数只由用户拍板决定，与代码逻辑无关，
 * 而"3 还是 4"这件事在 2026-10-02 被来回问过一次。写成常量、只此一处，
 * 下一轮要改的人不必去猜这个数字是从哪来的（也不必满文件找）。
 *
 * 取值 4：用户 2026-10-02 拍板（`docs/pending-issues/88-detail-page-layout.md` 第七节 7.5）。
 * 这个数**只影响概览行列出几个**，不影响计数行、也不影响每条判读自己那一行。
 */
export const IMPACT_OVERVIEW_WHO_MAX = 4;

/**
 * 一条判读的「影响：主体 · 方面」行（2026-10-02 第二刀，规格 7.5）。
 *
 * 三种形状都由这里决定，页面一个字都不拼（`.tsx` 里的拼接钉不住）：
 * - 都有 ⇒ `影响：<主体> · <方面>`
 * - 只有其一 ⇒ 只写有的那一半（不写一个空的 `·`，也不写"未标注"去凑格式）
 * - **都空 ⇒ `null`** —— 页面据此**整行不渲染**。这一条是本函数存在的主要理由：
 *   旧实现判的是 `impact.who ?`，于是"有方面没主体"的新形状会被整行吞掉。
 *
 * 两边各自 `trim` 后判空：存量行里 `who` 有过前导空格，而 `point` 是新字段，
 * 旧行解析出来是空串（`parseStoredImpacts` 的容错）—— 空串与新字段缺失在这里是同一件事。
 */
export function impactLine(impact: { who: string; point: string }): string | null {
  const who = impact.who.trim();
  const point = impact.point.trim();
  if (who !== '' && point !== '') return `影响：${who} · ${point}`;
  if (who !== '') return `影响：${who}`;
  if (point !== '') return `影响：${point}`;
  return null;
}

/**
 * 块首概览的形状（2026-10-02 第二刀，规格 7.5）。
 *
 * `countsLine` / `whoLine` 两行都是**程序聚合**出来的：不额外调模型，因此它们的措辞
 * 完全由本文件决定（这也是它必须能被单测钉住的原因）。
 */
export interface ImpactOverview {
  /** 判读条数（= 传入数组的长度；计数行里的"共 N 处"就是它） */
  total: number;
  /** 各类型的条数，固定顺序 risk → loophole → burden → other，且**只留 count > 0 的** */
  countsByKind: { kind: ImpactKind; count: number }[];
  /** trim 后非空的主体去重（按首次出现顺序），最多 `IMPACT_OVERVIEW_WHO_MAX` 个 */
  topWho: string[];
  /** 去重后的主体总数 − `topWho.length`（0 = 没有溢出，不写"等 N 类"） */
  whoOverflow: number;
  /** `共 6 处：2 处… · 2 处…`；`total === 0` ⇒ null（页面据此不渲染这一行） */
  countsLine: string | null;
  /** `影响：甲、乙 等 2 类`；`topWho` 为空 ⇒ null（一条判读都没写出主体时不硬凑一行） */
  whoLine: string | null;
}

/**
 * 概览行里类型的**固定顺序**（88 号文档 7.5 定的契约）：`risk → loophole → burden → other`，
 * 也就是类型联合与 `IMPACT_KIND_LABELS` 的**声明序**。
 *
 * 两条要点，改这个数组之前先读：
 * - **与判读在数组里的先后无关**：这一行是拿来**跨条目对照**的（同一条公示刷新两次、
 *   两条公示放一起看），顺序跟着输入漂就没法对照。
 * - 7.5 里那句示例最初写成「可能被规避或滥用」开头，那只是随手举的例子、**不是顺序契约**；
 *   实现与测试都按声明序 —— doc 与页面不许各说各话（这一族偏差本项目栽过多次）。
 *   所以这个数组与 `IMPACT_KIND_LABELS` 的键序必须一致，改了那张表就要一起改这里。
 */
const IMPACT_KIND_ORDER: ImpactKind[] = ['risk', 'loophole', 'burden', 'other'];

/**
 * 块首概览（2026-10-02 第二刀，规格 7.5）：一行计数 + 一行主体。
 *
 * 两条空值规矩与页面上的两个 `<p>` 一一对应，**判在这里、不判在页面**：
 * - `total === 0` ⇒ `countsLine` 为 null。调用方本来就有"一条都没有整块不渲染"的门
 *   （`shouldRenderImpacts`），这里再判一次是因为**这一行印出来就是"共 0 处"**——
 *   一句自相矛盾的话，比少一行难看得多。
 * - `topWho` 为空 ⇒ `whoLine` 为 null：一条判读都没写出主体时（模型留空是允许的，
 *   见提示词的"宁可空着"），不许印一行光秃秃的「影响：」。
 *
 * 措辞用 `IMPACT_KIND_LABELS` 的**实际取值**（不在这里另抄一份中文）：那份表是类型的
 * 单一来源，抄一份的后果是页面上同一个类型出现两种叫法。
 */
export function impactOverview(impacts: QuotedImpactPoint[]): ImpactOverview {
  const countsByKind = IMPACT_KIND_ORDER.map((kind) => ({
    kind,
    count: impacts.filter((impact) => impact.kind === kind).length,
  })).filter((row) => row.count > 0);

  /** 主体去重按**首次出现顺序**（不是字母序）：判读的顺序就是模型给的重要性顺序 */
  const seen = new Set<string>();
  const whoAll: string[] = [];
  for (const impact of impacts) {
    const who = impact.who.trim();
    if (who === '' || seen.has(who)) continue;
    seen.add(who);
    whoAll.push(who);
  }
  const topWho = whoAll.slice(0, IMPACT_OVERVIEW_WHO_MAX);
  const whoOverflow = whoAll.length - topWho.length;

  return {
    total: impacts.length,
    countsByKind,
    topWho,
    whoOverflow,
    countsLine:
      impacts.length === 0
        ? null
        : `共 ${impacts.length} 处：${countsByKind
            .map((row) => `${row.count} 处${IMPACT_KIND_LABELS[row.kind]}`)
            .join(' · ')}`,
    whoLine:
      topWho.length === 0
        ? null
        : `影响：${topWho.join('、')}${whoOverflow > 0 ? ` 等 ${whoOverflow} 类` : ''}`,
  };
}
