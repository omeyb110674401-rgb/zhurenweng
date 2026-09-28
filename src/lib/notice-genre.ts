/**
 * 公示体裁判定（issue #76）：同一条"征求意见"公告，**修正案与新案需要的摘要是两种东西**。
 *
 * 为什么要有这一层（读者视角的原始诉求，2026-09-25）：现在的摘要对附件条文的分析
 * "不够专业和全面"—— 但对**修正案**来说，全面逐条本来就不是读者要的：他要知道的是
 * "改了哪几处、为什么改、影响到谁"；而对**新案**，要的才是"每一章每一条规定了什么"。
 * 一套提示词服务两种需求，结果就是两边都不到位 —— 所以先分体裁，再分模板。
 *
 * 判据分强弱（生产 192 条实测，2026-09-25 只读；2026-09-26 按 #79 收窄过词表）：
 * - 强：附件**正文**里的措辞 —— "修改为 / 删去 / 增加一条"这类对照语（附件名里带
 *   "对照表"的只有 3 条，所以不能靠文件名 —— 信号在正文里，不在名字里）。
 *   `现行` 曾被当作强信号，实测它是**误判来源**：全新标准的编制说明里本来就会写
 *   "现行标准"，生产 52 条修正案里有 22 条是这样进来的，且一条改动都数不出来（#79）。
 * - 中：标题含"修正 / 修订"。注意标准也用"修订"（《城市绿地设计标准（修订征求意见稿）》），
 *   它同样是"改现行"体裁，归同一类是对的。
 * - 排除项先判：「…等11项强制性国家标准」「…等196项」这类**打包清单**、以及
 *   "委员名单 / 表彰 / 结果公示"这类**无条文文本**的条目 —— 它们既没有"逐条"可言，
 *   也没有可比的新旧文本可言，排错顺序会把打包标准误判成修正案（标题里往往带"修订"）。
 *
 * 两条硬规矩：
 * 1. **判不出来就是 `unknown`，不兜底成"新案"**。兜底会让 44 条修正案悄悄用错模板，
 *    而错的那一侧看起来是"摘要短了一点"，没人会去查；#9 的领域标签同样刻意没有兜底值。
 * 2. 判定必须**带得出依据**（`basis`）：存一列人话写的理由，后台看得见。
 *    一个看不出凭什么判的字段，操作者既不敢信也不会去修 —— 与 #58 删「调度配置」
 *    幽灵旋钮是同一条规矩。
 */

/** 公示体裁。`unknown` 是"未判定"，不是一个类别。 */
export type NoticeGenre =
  /** 修正案 / 修订案：改的是现行法律、法规、规章或标准 */
  | 'amendment'
  /** 新案：第一次立规，有完整的章条结构可逐条概括 */
  | 'new_draft'
  /** 打包清单：一次征求多项标准/计划项目，单条公告里没有可逐条概括的条文 */
  | 'package_plan'
  /** 名单与结果类：名单、表彰、换届、审核结果，本来就无条文 */
  | 'list_or_result'
  | 'unknown';

/** 展示名（后台与详情页角标用同一份，避免两处各写一遍中文）。 */
export const GENRE_LABELS: Record<NoticeGenre, string> = {
  amendment: '修正案',
  new_draft: '新案草案',
  package_plan: '打包清单',
  list_or_result: '名单/结果',
  unknown: '未判定',
};

export const NOTICE_GENRES = Object.keys(GENRE_LABELS) as NoticeGenre[];

/**
 * 附件正文里的"对照"措辞（强信号）：出现它，说明这份文件在改现行的文本。
 *
 * `现行` 曾在这张表里，2026-09-26 移出（issue #79）：**全新标准的编制说明里本来就会写
 * "现行标准 / 现行法律"**，所以它是把新案误判成修正案的高频来源 —— 生产 52 条修正案里
 * 有 22 条正是靠它判进来的。移出后这些条目按标题与新案措辞重判，存量用
 * `scripts/tag-notice-genres.mjs` 回填（判据就是本文件这份 `deriveNoticeGenre`，
 * 不在脚本里重写第二遍）。
 *
 * 2026-09-27（issue #85）：这张表曾被拆成"既判体裁也计数 / 只判体裁"两组 —— 因为
 * 「改动点」功能要拿其中一组去正文里数修改表述、算页面那行"共几处"的分母。改动点功能
 * 因**从未产出过**（全库 `changes` 非空 **0 条**）被整体删除，计数那一侧没有消费者了，
 * 两组于是收回一份：`原条款` 也回到这里 —— 它本来就是判体裁的证据（对照表里指代旧文本），
 * 当初被单独拿出去只是因为"数它只会数出一个假的分母"。
 */
export const AMENDMENT_TEXT_MARKERS: readonly string[] = ['修改为', '删去', '增加一条', '原条款'];

/** 标题里的修正案措辞（中标据：可能是"修订工作的意见"这类，故弱于正文措辞）。 */
const AMENDMENT_TITLE = /修正|修订/;

/** 打包清单：一个公告挂多项（实测样本："等11项强制性国家标准""等196项"、年度计划立项）。 */
const PACKAGE_TITLE = /等\s*\d+\s*[项个件]|年度.{0,6}计划|计划项目|立项|项目清单/;

/** 名单/结果类：没有条文文本，摘要要的是"谁进来了 / 结论是什么"。 */
const LIST_TITLE = /名单|表彰|表扬|通过审核|换届|备案公告|结果公示|拟.{0,4}奖励/;

/** 新案措辞（弱信号，只用来在排除项之后把"确实是份草案"这件事说出来）。 */
const NEW_DRAFT_TITLE =
  /草案|征求意见稿|办法|规定|规则|规程|导则|规范|指南|条例|实施细则|技术文件/;

export interface GenreEvidence {
  title: string;
  /** 附件文件名清单（入库时就有，不必等抽取） */
  attachmentNames?: string[];
  /**
   * 附件正文的拼接文本（抽取任务之后才拿得到）。
   * 传与不传会让同一条目从 new_draft 升级成 amendment —— 这是**特性**：
   * 抽取任务完成后要重算一次体裁，因为最强那条证据只在正文里。
   */
  attachmentText?: string | null;
}

export interface GenreDecision {
  genre: NoticeGenre;
  /** 人话写的判定依据，落库存着给后台看 */
  basis: string;
  /** 证据种类：决定"谁能覆盖谁"（见 GENRE_EVIDENCE_RANK 的说明） */
  evidence: GenreEvidenceKind;
}

/**
 * 证据种类与强度。
 *
 * 为什么要把强度单独存一列而不是每次重算完直接覆盖：抓取每轮都会重写标题与附件清单，
 * 而**附件正文**要到抽取任务（另一个 job）跑完才存在。若更新分支无条件覆盖，
 * 抽取任务刚把某条升级成"修正案（正文含'修改为'）"，下一轮抓取就会把它降回"仅标题证据"，
 * 于是同一批数据在两个 job 之间来回跳 —— 读者看到的摘要形态也会跟着抖。
 * 规矩很简单：**弱证据不许覆盖强证据**，除非标题真的变了（标题变了由调用方显式重算）。
 */
export type GenreEvidenceKind = 'none' | 'title' | 'attachment_names' | 'attachment_text';

export const GENRE_EVIDENCE_RANK: Record<GenreEvidenceKind, number> = {
  none: 0,
  title: 1,
  attachment_names: 2,
  attachment_text: 3,
};

/** 新判定能不能覆盖已存的判定（同强度可以覆盖：同证据下标题变了要跟着变）。 */
export function genreDecisionWins(
  next: GenreEvidenceKind,
  stored: GenreEvidenceKind | null | undefined,
): boolean {
  if (stored == null) return true;
  return GENRE_EVIDENCE_RANK[next] >= GENRE_EVIDENCE_RANK[stored];
}

/**
 * 判据顺序即优先级：先排"根本没有条文"的两类，再判修正案，最后才是新案。
 * 顺序换一下就会错判：打包标准的标题常带"（修订征求意见稿）"，先判修正会把它们全吞掉。
 */
export function deriveNoticeGenre(evidence: GenreEvidence): GenreDecision {
  const title = evidence.title ?? '';
  const names = evidence.attachmentNames ?? [];

  const listHit = LIST_TITLE.exec(title);
  if (listHit) {
    return { genre: 'list_or_result', basis: `标题含「${listHit[0]}」，无条文文本`, evidence: 'title' };
  }
  const packageHit = PACKAGE_TITLE.exec(title);
  if (packageHit) {
    return { genre: 'package_plan', basis: `标题含「${packageHit[0]}」，一条公告挂多项`, evidence: 'title' };
  }

  // 附件名里的"对照表"是决定性的：它就是官方自带的新旧对照
  const duizhao = names.find((name) => name.includes('对照'));
  if (duizhao) {
    return { genre: 'amendment', basis: `附件「${duizhao}」是新旧对照表`, evidence: 'attachment_names' };
  }

  const text = evidence.attachmentText ?? '';
  if (text !== '') {
    const marker = AMENDMENT_TEXT_MARKERS.find((word) => text.includes(word));
    if (marker) {
      return { genre: 'amendment', basis: `附件正文含对照措辞「${marker}」`, evidence: 'attachment_text' };
    }
  }

  if (AMENDMENT_TITLE.test(title)) {
    // 只有标题措辞时把"依据弱"这件事写在 basis 里：将来正文抽出来还会重算一次
    return { genre: 'amendment', basis: '标题含「修正/修订」（仅标题证据，未看到条文正文）', evidence: 'title' };
  }

  const draftHit = NEW_DRAFT_TITLE.exec(title);
  if (draftHit) {
    return { genre: 'new_draft', basis: `标题含「${draftHit[0]}」且无改现行文本的迹象`, evidence: 'title' };
  }

  return { genre: 'unknown', basis: '标题与附件名都没有体裁线索，不兜底成任何一类', evidence: 'none' };
}
