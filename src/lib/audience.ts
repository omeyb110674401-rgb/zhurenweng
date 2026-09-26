/**
 * 受众面判定（issue #83）：同一条"征求意见"公告，**该去提意见的人**不是同一批人。
 *
 * 站长的原始诉求（2026-09-26）："关于征召的专业性和覆盖性问题的分类，比如特定领域的如
 * 林业、住房这类对特定人群或专业人士影响较大的最好作为一个大类，而对公众影响较大的
 * 立法、税收等影响范围广的则需要作为另一个大类"。
 *
 * 与领域标签（`categories.ts` 的 10 个领域）的关系：**两个正交的维度**。
 * 领域回答"这是关于什么事的"（生态环境 / 交通运输…），受众面回答"该谁来看、该谁去提意见"。
 * 一条《水法（修订草案）》既属于「立法与司法」也属于「公众广域」；一条《城市绿地设计标准
 * （修订征求意见稿）》可能是「生态环境」，却是「行业专业」—— 后者才是"我要不要点进去"的判据。
 *
 * 两个硬规矩（与体裁判定 `notice-genre.ts` 同源）：
 * 1. **判不出来就是 `unknown`，不兜底成任何一类**。兜底会让"专业标准"被当成"人人都该看的
 *    立法"推给读者，而"我为什么要看这个"的答案错了，比没有这个分类更糟。
 * 2. **判定必须带得出依据**（`basis`）：存一列人话写的理由。一个说不出凭什么判的字段，
 *    使用者既不敢信、也没法改 —— 与 #58 删「调度配置」是同一条规矩。
 *
 * 判据口径是**「谁该去提意见」**，不是"谁会被影响到"。这条口径是有意的，也是本分类最容易被
 * 误读的地方：一份《电梯安全技术规程》影响的当然包括每个乘电梯的人，但**能对它提意见的是
 * 特种设备生产、维保与检验单位**，所以它判「行业专业」。反过来，《道路交通安全法（修订草案）》
 * 的技术细节同样只有专业人士说得清，但它是法律、面向全体道路使用者征求意见，判「公众广域」。
 * 一句话：**看这份文件把谁当征求意见的对象**。
 *
 * 规则表与阈值随数据面增长而增补（收录量级是每月数十条国家级公示），不做运行时配置面 ——
 * 与 `categories.ts` 的取舍一致。判定口径落在代码里，`scripts/tag-notice-audience.mjs`
 * 用它回填存量，两处不会分叉。
 */

/** 受众面。`unknown` 是"未判定"，不是一个类别。 */
export type NoticeAudience =
  /** 公众广域：立法、税收、社保医保、教育、消费等，影响不特定多数人 */
  | 'public'
  /** 行业专业：技术标准、行业规程、许可准入、特定职业事项，读者以从业者为主 */
  | 'sector'
  | 'unknown';

/** 展示名（列表筛选、详情页角标、统计页共用同一份，避免两处各写一遍中文）。 */
export const AUDIENCE_LABELS: Record<NoticeAudience, string> = {
  public: '公众广域',
  sector: '行业专业',
  unknown: '未判定',
};

/** 一句话说明（筛选条目的 title 提示与统计页表头用）。 */
export const AUDIENCE_HINTS: Record<NoticeAudience, string> = {
  public: '立法、税收、社保医保、教育、消费等，影响不特定多数人',
  sector: '技术标准、行业规程、许可准入、特定职业事项，读者以从业者为主',
  unknown: '标题与来源都没有足够线索，不硬塞进任何一类',
};

/**
 * 可筛选取值与展示顺序。`unknown` 也在内 —— 它不是凑数的：对运营者来说
 * 「未判定」正是"还没归类好的那一批"，筛出来才能逐条改进规则（见 #83 的迭代约定）。
 */
export const NOTICE_AUDIENCES: readonly NoticeAudience[] = ['public', 'sector', 'unknown'];

const KNOWN_AUDIENCES: ReadonlySet<string> = new Set<string>(NOTICE_AUDIENCES);

/** querystring 取值是否为已知受众面（未知值不生效，与领域标签同一处理）。 */
export function isKnownAudience(value: string): value is NoticeAudience {
  return KNOWN_AUDIENCES.has(value);
}

export interface AudienceEvidence {
  title: string;
  /**
   * 来源渠道 ID。目前只有 `npc`（全国人大）参与判定：那个源上的条目**全是法律草案**，
   * 是"立法 ⇒ 公众广域"最硬的一条证据，比标题措辞可靠。
   */
  sourceId?: string;
  /**
   * 条目 id（原文 URL 的 sha256 前缀，入库时就有、且确定性生成）。
   * 只有人工覆盖表用得到它：覆盖表按 id 前缀登记，因为**只有 id 是稳定的**
   * （标题会被源站改、也会被我们归一化，用它当键等于让覆盖随标题漂移）。
   */
  id?: string;
}

export interface AudienceDecision {
  audience: NoticeAudience;
  /** 人话写的判定依据，落库存着 */
  basis: string;
}

/**
 * 法律 / 条例草案（含行政法规）：括号里写着"草案 / 征求意见稿"才算 —— 这个限制挡掉
 * 「《保障中小企业款项支付条例》3项配套制度」这类**实施性文件**（那是行业事项，不是立法）。
 * 负向断言再挡掉"办法（修订草案…）"里的"法"字。
 *
 * `法（征求意见稿）` 也算：生产实测《中华人民共和国反网络暴力法（征求意见稿）》
 * 括号里没有"草案"二字，按旧判据落进了未判定 —— 法律草案的措辞不止一种。
 */
const LAW_DRAFT =
  /(?<![办方做想用说合])法\s*[（(][^）)]{0,20}(草案|征求意见稿)|条例\s*[（(][^）)]{0,20}(草案|征求意见稿)|国务院关于[^《》]{0,40}的规定/;

/** 税收与收费：直接落在每个人 / 每个市场主体身上，不看括号里是什么文件类型。 */
const PUBLIC_TAX = /税|关税|政府定价|价格听证/;

/**
 * 民生事项：挑的是**没有歧义**的词。刻意不含「食品」「消费」「供水」「燃气」这类 ——
 * 它们会命中《婴幼儿配方乳粉…注册现场核查要点》（对生产企业，行业专业）与
 * 《城镇供水…技术标准》（对水务单位，行业专业）。宁缺勿滥，判不准就落未判定。
 */
const PUBLIC_LIVELIHOOD =
  /社会保险|社保|医疗保险|医保|养老保险|养老金|失业保险|工伤保险|生育保险|最低生活保障|社会救助|住房公积金|就业|劳动合同|工资|消费者权益|消费者保护|食品安全|药品|疫苗|医疗器械|医疗服务|医疗机构|教育|学校|学位|招生|考试|教师|未成年人|儿童|青少年|老年人|妇女|残疾人|退役军人|慈善|殡葬|个人信息保护/;

/** 技术文件：标准 / 规程 / 导则一类，读者是执行它的专业技术人员。 */
const SECTOR_TECH =
  /标准|规程|规范|导则|通则|技术要求|技术条件|试验方法|测定|检测|检验|认证|认可|计量|定额|图集|编码|设计|施工|验收|运维|监测|方法学/;

/** 行业管理事项：许可、准入、备案、评价一类，管的是从业者与市场主体。 */
const SECTOR_ADMIN =
  /许可|准入|资质|备案|审查细则|规范条件|管理办法|暂行办法|实施细则|认定|评估|评价|信用管理|招标|投标|政府采购|行业|产业|企业|生产|制造|装备|工程|运营|管道|管网|结构|材料|设施|设备|系统|专项规划|编制|名录|配额|行政复议|行政处罚|行政执法|登记|注册|核查|清单|信用|指引|实施规则|标识|单位制/;

/** 专业领域词：这些词一出现，读者面就基本落在该领域的从业者身上。 */
const SECTOR_FIELD =
  /林业|草原|湿地|水利|水电|电力|电网|核电|核动力|煤炭|石油|天然气|油气|矿产|矿山|冶金|化工|建材|机械|汽车|车辆|船舶|游艇|航空|民航|铁路|公路|港口|航道|通信|无线电|软件|集成电路|半导体|农药|肥料|饲料|兽药|种子|农机|气象|测绘|海洋|地质|地震|辐射|烟火|爆炸|危险化学品|标准化|粮食/;

/** 名单与结果：委员名单、换届、审核结果 —— 关心的是该行业里的人。 */
const SECTOR_LIST = /名单|换届|委员|表彰|表扬|结果公示|审核结果|备案公告/;

/**
 * 人工覆盖表（issue #83 的迭代约定）：规则判错时在这里逐条登记，**必须写清理由**。
 *
 * 为什么不是"改关键词"了事：中文关键词没有边界，为了修一条而加一个更长的词，
 * 常常换来另一条的新误判（`categories.ts` 的 KEYWORD_CONTEXT_EXCLUSIONS 就是被这件事
 * 逼出来的）。规则表管"大多数"，覆盖表管"我核过的这一条" —— 两者分开，回归测试才钉得住。
 *
 * 增删流程：跑 `node scripts/audit-notice-audience.mjs` 看全量判定与依据，把判错的
 * 连**条目 id 前缀**与理由一起登记在这里，再跑 `scripts/tag-notice-audience.mjs --apply`
 * 回填；单测 `tests/unit/audience.test.mjs` 里对着这些条目钉住结果。
 */
export interface AudienceOverride {
  /** 条目 id 前缀（8 位十六进制，与回填脚本的 `--ids` 同一口径） */
  match: string;
  audience: NoticeAudience;
  why: string;
}

export const AUDIENCE_OVERRIDES: readonly AudienceOverride[] = [
  {
    // 内外贸产品同线同标同质、促进消费扩容提质：面向的是消费者与市场主体，
    // 不是某行业的技术执行者。规则表里"消费/产品"这类词刻意没进公众词表
    // （它们会误伤《婴幼儿配方乳粉…注册核查要点》），所以这一条走覆盖表。
    match: '954dcc17',
    audience: 'public',
    why: '促进消费扩容提质，面向消费者与市场主体，不是行业技术执行者',
  },
  {
    // 标题里的「教育」把这条拉进了公众广域，但它是教育系统**内部**审计的工作规定，
    // 读者是系统内的审计与财务人员 —— 关键词规则救不了这种"看名字像民生、看内容像内务"的条目。
    match: '61323da4',
    audience: 'sector',
    why: '教育系统内部审计工作规定，读者是系统内审计人员，不是家长与学生',
  },
  {
    // 同理：标题里的「食品安全」把"征抽检计划建议"拉进了公众广域，而这份公告征集的是
    // 检验检测机构与专家的意见（计划怎么排、抽什么），不是给消费者的食品安全规定。
    match: 'c81057ef',
    audience: 'sector',
    why: '食品安全抽检**计划**建议征集，面向检验检测机构与专家，不是面向消费者的食品规定',
  },
];

/**
 * 判定受众面。顺序即优先级：
 * 立法 → 税收 → 民生 → 行业（技术 / 管理 / 领域词 / 名单）→ 未判定。
 *
 * 顺序换一下就会错判，最典型的是「公路法（修正草案）」与「城市道路照明设计标准」：
 * 前者含「公路」（专业领域词）、后者含「道路」，先判行业就会把**法律**判成行业文件。
 */
export function deriveNoticeAudience(evidence: AudienceEvidence): AudienceDecision {
  const title = evidence.title ?? '';

  const id = evidence.id ?? '';
  const override = id === ''
    ? undefined
    : AUDIENCE_OVERRIDES.find((item) => id.startsWith(item.match));
  if (override) {
    return { audience: override.audience, basis: `人工覆盖：${override.why}` };
  }

  if (evidence.sourceId === 'npc') {
    return { audience: 'public', basis: '来源是全国人大，该源条目均为法律草案（立法）' };
  }
  const lawHit = LAW_DRAFT.exec(title);
  if (lawHit) {
    return { audience: 'public', basis: `标题是法律/条例草案（「${lawHit[0]}」），面向全体征求意见` };
  }

  const taxHit = PUBLIC_TAX.exec(title);
  if (taxHit) {
    return { audience: 'public', basis: `标题含「${taxHit[0]}」，税收与收费直接落在每个人/每个市场主体身上` };
  }

  const livelihoodHit = PUBLIC_LIVELIHOOD.exec(title);
  if (livelihoodHit) {
    return { audience: 'public', basis: `标题含「${livelihoodHit[0]}」，属面向不特定多数人的民生事项` };
  }

  const techHit = SECTOR_TECH.exec(title);
  if (techHit) {
    return { audience: 'sector', basis: `标题含「${techHit[0]}」，是给专业技术人员执行的文件` };
  }

  const adminHit = SECTOR_ADMIN.exec(title);
  if (adminHit) {
    return { audience: 'sector', basis: `标题含「${adminHit[0]}」，管的是从业者与市场主体` };
  }

  const fieldHit = SECTOR_FIELD.exec(title);
  if (fieldHit) {
    return { audience: 'sector', basis: `标题含专业领域词「${fieldHit[0]}」，读者以该领域从业者为主` };
  }

  const listHit = SECTOR_LIST.exec(title);
  if (listHit) {
    return { audience: 'sector', basis: `标题含「${listHit[0]}」，关心它的是该行业里的机构与人` };
  }

  return { audience: 'unknown', basis: '标题与来源都没有足够线索，不兜底成任何一类' };
}
