/**
 * 领域标签体系（issue #9）：领域清单 + 入库自动打标的关键词规则。
 *
 * 设计要点：
 * - **单一词表**：领域标签值（label）同时是订阅领域选项（issue #7 的
 *   CATEGORY_OPTIONS，经 subscription.ts 引用本表）与列表页分类筛选的
 *   querystring 取值（/?category=…），三处消费同一份常量，杜绝词表漂移。
 * - **关键词规则**：每个领域一组关键词，命中条目标题或正文（不区分大小写）
 *   即打上该领域标签；多领域同时命中则多标签（categoryTags 为数组）。
 * - **排除语境**：个别关键词只出现在特定更长词内部时不算命中，见
 *   KEYWORD_CONTEXT_EXCLUSIONS —— 两种情况都来自真实数据：「数据」在专有名词
 *   「国家法律法规数据库」内；「信息化」在机关名「工业和信息化部」内（词表
 *   刻意避开机关名，但这个词避不开，只能靠排除语境兜底）。
 * - **名单 / 通讯信息行过滤**：打标前先剔掉正文里的「序号 + 机构名」名单行与
 *   地址邮编行 —— 机构名是开放集合，无法用排除语境逐词登记，见
 *   stripListAndContactLines。
 * - **无兜底标签**：没有任何关键词命中的条目 categoryTags 保持空数组
 *   （不强行归入「其他」）——订阅词表因此无需引入一个永远泛匹配的领域，
 *   未打标条目仍出现在未筛选列表与检索结果中，只是不参与领域筛选。
 * - **规则可配置于代码**：收录量级为每月数十条国家级公示，关键词规则表
 *   以代码内常量维护（随数据面扩展逐步增补），不做运行时配置面。
 * - 关键词为受控词表：刻意避开「司法」「网络」「市场」「环境」「运输」
 *   「企业」「邮政」「科技」这类机关名 / 高频泛词（「司法部」「法制信息网」
 *   并非司法领域、「邮政编码：」并非交通运输、「科技与法制司」并非科技领域、
 *   「铁路运输企业」并非经济与产业），宁缺勿滥，保证打标准确率；
 *   真实领域文本通常由更完整的词命中（如「科学技术」「邮政业」）。
 * - 词表避不开的机关名用「排除语境」兜底（见 KEYWORD_CONTEXT_EXCLUSIONS）：
 *   「工业和信息化部」含关键词「信息化」但属机关名，无法靠换词解决。
 */

/** 领域定义：标签值 + 该领域的关键词规则（命中标题或正文即打标）。 */
export interface DomainCategory {
  /** 领域标签值（入库 categoryTags 的元素、订阅选项、列表筛选参数共用） */
  label: string;
  /** 关键词规则：任一关键词命中标题或正文即打上本领域标签 */
  keywords: readonly string[];
}

/** 首批领域与关键词规则表（issue #9）。顺序即打标顺序与标签云展示顺序。 */
export const DOMAIN_CATEGORIES: readonly DomainCategory[] = [
  {
    label: '立法与司法',
    // 「草案」是法案 / 条例草案的立法活动标记：真实数据里只出现在 npc 法案与 moj 条例
    // 草案（30 条 mee 生态环境标准正文一次都没有），因此不含「标准草案」误伤。
    keywords: ['立法', '草案', '仲裁', '公证', '调解', '律师', '法律援助', '法律服务', '司法鉴定', '行政复议', '监狱'],
  },
  {
    label: '经济与产业',
    keywords: ['产业', '中小企业', '市场主体', '能源', '电力', '煤炭', '石油', '天然气', '矿产', '外商投资', '招标投标', '对外贸易', '关税'],
  },
  {
    label: '科技与互联网',
    keywords: ['科学技术', '科技创新', '科技成果', '高新技术', '知识产权', '专利', '商标', '著作权', '人工智能'],
  },
  {
    label: '教育与科研',
    keywords: ['教育', '学校', '教师', '学位', '学科', '科研', '考试', '招生'],
  },
  {
    label: '医疗卫生',
    keywords: ['医疗', '医保', '医药', '药品', '医院', '医师', '医生', '护士', '卫生', '诊疗', '疾病', '疫苗', '患者', '传染病'],
  },
  {
    label: '生态环境',
    keywords: ['生态', '环保', '环境保护', '污染', '排放', '碳排放', '碳达峰', '碳中和', '自然保护地', '自然保护区', '野生动物', '野生植物', '森林', '草原', '湿地', '海洋', '固体废物', '噪声'],
  },
  {
    label: '交通运输',
    keywords: ['交通', '铁路', '公路', '道路', '民航', '航空', '港口', '轨道交通', '邮政业', '快递', '车辆', '船舶', '航道', '水运'],
  },
  {
    label: '市场监管',
    keywords: ['市场监管', '市场准入', '反垄断', '反不正当竞争', '公平竞争', '社会信用', '信用体系', '失信惩戒', '营商环境', '产品质量', '食品安全', '特种设备', '消费者权益', '认证认可', '标准化'],
  },
  {
    label: '社会保障',
    keywords: ['社会保险', '社会救助', '社会福利', '最低生活保障', '养老', '就业', '劳动', '工资', '工伤', '失业', '慈善', '优抚', '退役军人', '残疾人'],
  },
  {
    label: '数据与网络安全',
    keywords: ['数据', '网络安全', '数据安全', '个人信息', '互联网', '信息化', '数字化', '电子商务', '算法', '电信', '无线电'],
  },
];

const KNOWN_CATEGORY_LABELS: ReadonlySet<string> = new Set(
  DOMAIN_CATEGORIES.map((domain) => domain.label),
);

/**
 * 关键词的排除语境（issue #15 缺陷 2）：关键词只出现在这些更长词内部时不算命中。
 * 中文没有词边界，「数据」在「国家法律法规数据库」里只是专有名词的一部分 ——
 * 真实 npc 正文通篇引用该数据库，导致三条立法类条目被误打「数据与网络安全」。
 * 判定方式为「先剔除排除词、再看关键词是否仍出现」（剔除是字面替换，不做分词）；
 * 只登记真正包含该关键词的排除词 —— 否则剔除动作本身可能把两个残段拼成关键词，
 * 造成新的假命中。
 */
const KEYWORD_CONTEXT_EXCLUSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['数据', ['数据库']],
  // 「工业和信息化部（厅 / 委员会）」是机关名，真实 mee 通知的「征求意见单位」名单里
  // 会出现它 —— 机关名不该把一份排放标准打进数据与网络安全领域。
  ['信息化', ['工业和信息化']],
]);

/** 值是否为已知领域标签（列表筛选参数校验：未知值不生效，避免任意串触发无效筛选）。 */
export function isKnownCategory(value: string): boolean {
  return KNOWN_CATEGORY_LABELS.has(value);
}

/**
 * 「名单条目」行：序号 + 短名称 + 无句读 / 无括号 / 无书名号 + 含机构名特征词。
 * 例：「5.国家能源局综合司」「9.中国电力企业联合会」「10.中国产业发展促进会生物质能产业分会」。
 *
 * 两个条件缺一不可：只按「无标点短行」判会连带剔掉枚举式正文行（如
 * 「1.加强源头防控」「2.推进能源结构调整」）；而机构名特征词缺失只会漏剔
 * （该行保留，最多留下一次误报），不会误删正文 —— 因此特征词表宁可宽，判据
 * 以「不误删」为先。
 */
const LIST_ENTRY_LINE = /^\s*\d+[.．、]\s*[^。，、；：！？《》（）]{2,40}$/;
/** 机构名特征词（部委 / 院所 / 集团 / 协会 / 地方单位……）：缺失只漏剔，不误删 */
const ORG_NAME_HINT =
  /(中国|国家|国际|部|委|局|厅|署|办|司|院|所|中心|站|集团|公司|协会|学会|联合会|大学|学院|基地|银行|委员会|研究所|研究院|编辑部|出版社|学校|医院|实验室|分会|企业)/;

/** 是否为机构名单行（issue #16）。 */
function isListEntryLine(line: string): boolean {
  return LIST_ENTRY_LINE.test(line) && ORG_NAME_HINT.test(line);
}

/**
 * 「通讯信息」行：地址 / 邮编开头（与词表刻意避开「邮政编码：」同一理由）。
 * 例：「地址：北京市海淀区永丰产业基地丰德东路4号」「邮编：100012」。
 */
const CONTACT_LINE = /^\s*(?:地址|通讯地址|邮寄地址|联系地址|邮编|邮政编码)\s*[：:]/;

/**
 * 打标前的正文预处理（issue #16）：剔掉机构名单行与通讯信息行。
 *
 * 真实 mee 通知末尾会列「征求意见单位」名单（**每行一个机构名**）与联系人通讯地址，
 * 这些行里的机构名 / 地名会命中领域关键词（能源 / 电力 / 产业 / 石油），把一份
 * 《铀矿冶流出物和辐射环境监测规定》打进「经济与产业」—— 全库 45 条里 11 条受影响。
 * 名单是开放的（部委、集团、协会、学会、地方产业园……），无法用「排除语境」逐词登记，
 * 只能按行剔除。
 *
 * 判据来自生产库 45 条全量校验：两条规则共命中 141 行，逐行人工确认**全部**是
 * 名单条目 / 标签行 / 地址邮编行，无一条是正文。括号与书名号是附件清单条目的特征
 * （如「9.《固体废物 石油烃（C10-C40）的测定 气相色谱法（征求意见稿）》编制说明」），
 * 因此附件行不会被误删 —— 附件标题描述的就是公示主题，命中领域关键词是合理的。
 */
export function stripListAndContactLines(bodyText: string): string {
  return bodyText
    .split('\n')
    .filter((line) => !isListEntryLine(line) && !CONTACT_LINE.test(line))
    .join('\n');
}

/**
 * 关键词是否命中文本（已小写化的 haystack 与 keyword 传入）。
 * 有排除语境的关键词先剔除排除词再判包含（见 KEYWORD_CONTEXT_EXCLUSIONS）。
 */
function keywordHits(haystack: string, keyword: string): boolean {
  const exclusions = KEYWORD_CONTEXT_EXCLUSIONS.get(keyword);
  if (exclusions === undefined) return haystack.includes(keyword);
  let remaining = haystack;
  for (const exclusion of exclusions) {
    remaining = remaining.replaceAll(exclusion, '');
  }
  return remaining.includes(keyword);
}

/**
 * 按关键词规则为条目打领域标签（入库自动打标，issue #9）。
 * 任一关键词命中标题或正文（不区分大小写）即记入该领域；按领域表顺序输出，
 * 每领域至多一个标签；无命中返回空数组（不打兜底标签，见模块注释）。
 * 正文先经 stripListAndContactLines 剔掉名单 / 通讯信息行（issue #16）；
 * 标题不做过滤 —— 标题是权威的主题表述，本身不会是名单行。
 */
export function deriveCategoryTags(title: string, bodyText?: string | null): string[] {
  const haystackTitle = title.toLowerCase();
  const haystackBody = stripListAndContactLines(bodyText ?? '').toLowerCase();
  const tags: string[] = [];
  for (const domain of DOMAIN_CATEGORIES) {
    const hit = domain.keywords.some((keyword) => {
      const needle = keyword.toLowerCase();
      return keywordHits(haystackTitle, needle) || keywordHits(haystackBody, needle);
    });
    if (hit) tags.push(domain.label);
  }
  return tags;
}
