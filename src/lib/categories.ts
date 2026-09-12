/**
 * 领域标签体系（issue #9）：领域清单 + 入库自动打标的关键词规则。
 *
 * 设计要点：
 * - **单一词表**：领域标签值（label）同时是订阅领域选项（issue #7 的
 *   CATEGORY_OPTIONS，经 subscription.ts 引用本表）与列表页分类筛选的
 *   querystring 取值（/?category=…），三处消费同一份常量，杜绝词表漂移。
 * - **关键词规则**：每个领域一组关键词，命中条目标题或正文（不区分大小写）
 *   即打上该领域标签；多领域同时命中则多标签（categoryTags 为数组）。
 * - **无兜底标签**：没有任何关键词命中的条目 categoryTags 保持空数组
 *   （不强行归入「其他」）——订阅词表因此无需引入一个永远泛匹配的领域，
 *   未打标条目仍出现在未筛选列表与检索结果中，只是不参与领域筛选。
 * - **规则可配置于代码**：收录量级为每月数十条国家级公示，关键词规则表
 *   以代码内常量维护（随数据面扩展逐步增补），不做运行时配置面。
 * - 关键词为受控词表：刻意避开「司法」「网络」「市场」「环境」「运输」
 *   「企业」这类机关名 / 高频泛词（「司法部」「法制信息网」并非司法领域、
 *   「市场环境」并非生态环境），宁缺勿滥，保证打标准确率。
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
    keywords: ['立法', '仲裁', '公证', '调解', '律师', '法律援助', '法律服务', '司法鉴定', '行政复议', '监狱'],
  },
  {
    label: '经济与产业',
    keywords: ['产业', '中小企业', '市场主体', '能源', '电力', '煤炭', '石油', '天然气', '矿产', '外商投资', '招标投标', '对外贸易', '关税'],
  },
  {
    label: '科技与互联网',
    keywords: ['科技', '科学技术', '知识产权', '专利', '商标', '著作权', '人工智能', '高新技术'],
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
    keywords: ['交通', '铁路', '公路', '道路', '民航', '航空', '港口', '轨道交通', '邮政', '快递', '车辆', '船舶', '航道', '水运'],
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

/** 值是否为已知领域标签（列表筛选参数校验：未知值不生效，避免任意串触发无效筛选）。 */
export function isKnownCategory(value: string): boolean {
  return KNOWN_CATEGORY_LABELS.has(value);
}

/**
 * 按关键词规则为条目打领域标签（入库自动打标，issue #9）。
 * 任一关键词命中标题或正文（不区分大小写）即记入该领域；按领域表顺序输出，
 * 每领域至多一个标签；无命中返回空数组（不打兜底标签，见模块注释）。
 */
export function deriveCategoryTags(title: string, bodyText?: string | null): string[] {
  const haystackTitle = title.toLowerCase();
  const haystackBody = (bodyText ?? '').toLowerCase();
  const tags: string[] = [];
  for (const domain of DOMAIN_CATEGORIES) {
    const hit = domain.keywords.some((keyword) => {
      const needle = keyword.toLowerCase();
      return haystackTitle.includes(needle) || haystackBody.includes(needle);
    });
    if (hit) tags.push(domain.label);
  }
  return tags;
}
