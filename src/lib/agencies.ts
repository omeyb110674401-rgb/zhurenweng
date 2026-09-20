/**
 * 发布机关名归一与多发布机关拆分（issue #21）。
 *
 * ## 为什么需要这一层
 *
 * `agency` 是**忠实于源站的显示值**：适配器从标题前缀（「司法部、中国人民银行…关于《…》
 * 的通知」）或栏目常量取到，因此同一个机关会出现多种写法、联合发文会出现复合串。
 * 源扩到 8 个之后，生产库里 150 条出现了 18 种机关写法，其中三类是真问题：
 *
 * 1. **同一机关两种写法**（源站自己就不一致）：「中国民用航空局关于《民用航空空中交通
 *    管理规则》…」与「中国民航局关于《运输机场运营许可规定》…」—— 交通运输部栏目里
 *    同一主办机关的两条公告写法不同，筛选与统计因此被拆成两行；
 * 2. **联合发文是一个复合串**：「司法部、中国人民银行、金融监管总局、中国证监会、
 *    国家外汇局」——按机关筛选时，选「司法部」看不到它，选「中国人民银行」也看不到它
 *    （下拉里根本没有这个选项）；
 * 3. 同一栏目两种来源给出的机关名不一致（如生态环境部栏目的两套详情模板，见 mee.ts）。
 *
 * ## 做法
 *
 * - `canonicalAgency`：别名表把已知的同一机关写法收敛到一个名字（**只在有实测依据时
 *   才加**，不做猜测性归一）；
 * - `splitAgencies`：按顿号 / 空白拆分复合串得到参与机关集合，逐个归一、去重、保序；
 * - `leadAgencyOf`：**牵头机关**（第一个）—— 联合发文在统计里归到牵头机关名下，
 *   这样「各部门公示量」不会出现一行只 1 条的复合串，且不重复计数；
 * - `agencyKeysOf`：参与机关集合的**竖线包夹串**（`|司法部|中国人民银行|`），
 *   入库到 `notices.agency_keys`，让「按任一参与机关筛选」能用一条
 *   `LIKE '%|X|%'` 精确表达（与 categoryTagsJson 的筛选同一套路数，见
 *   src/db/repo/notices.ts）。
 *
 * 刻意**不做**的事：不把内设机构折进部本级（「市场监管总局特种设备局」「生态环境部
 * 办公厅」是源站自己署的发文机关，是真实信息，折掉就丢了）。机关层级归并是另一个
 * 话题，需要权威的机构表，不在本轮范围内。
 */

/**
 * 别名表：同一机关的已知不同写法 → 规范名（**只在有实测依据时新增**）。
 *
 * - 中国民航局 / 中国民用航空局：交通运输部「意见征集」栏目内同一主办机关的两条公告
 *   分别用了简称与全称（实测 2026-09-20 生产库），规范名取**全称**（官方署名形式）。
 */
const AGENCY_ALIASES: Record<string, string> = {
  中国民航局: '中国民用航空局',
};

/** 复合机关串的分隔符：顿号（常见）与空白（源站排版差异）。 */
const AGENCY_SEPARATOR = /[、\s]+/;

/** 归一单个机关名（去空白 + 别名收敛）；空串返回空串。 */
export function canonicalAgency(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  return AGENCY_ALIASES[trimmed] ?? trimmed;
}

/**
 * 拆分复合机关串为参与机关集合（逐个归一、去重、保序）。
 * 单机关返回单元素数组；空串返回空数组。
 */
export function splitAgencies(agency: string): string[] {
  const parts = agency.split(AGENCY_SEPARATOR).map(canonicalAgency).filter((part) => part.length > 0);
  return [...new Set(parts)];
}

/**
 * 牵头机关（第一个参与机关）：联合发文在「各部门公示量 / 月度趋势」里归到它名下，
 * 保证每条只计一次。空串返回空串。
 */
export function leadAgencyOf(agency: string): string {
  return splitAgencies(agency)[0] ?? '';
}

/**
 * 参与机关集合的竖线包夹串（`|司法部|中国人民银行|`）。
 * 竖线包夹让「任一参与机关」的匹配可以用 `LIKE '%|X|%'` 精确表达，
 * 不会出现「司法部」命中「司法部办公厅」这类子串误命中。
 */
export function agencyKeysOf(agency: string): string {
  const parts = splitAgencies(agency);
  return parts.length === 0 ? '' : `|${parts.join('|')}|`;
}
