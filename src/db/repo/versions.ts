import { eq } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { notices } from '../schema/sqlite.ts';
import { normalizeTitleForVersionMatch } from '../../lib/versions.ts';

/**
 * 版本链关联（issue #10）：同一法案不同轮次公示 → 关联为版本链。
 *
 * 数据形状：notices 自引用两列 —— `version_of` 指向**上一轮**条目 id，
 * `version_seq` 为轮次序号（1 = 首轮公示）；首版 / 未关联条目 version_of 为 NULL。
 * （选直接前驱指向而非「链根指向」：对比上一版只需一次主键查询。）
 *
 * 策略：整链重算。每有条目入库 / 更新，就把同（规范化标题 × 发布机关）分组的
 * 全部条目按发布日期升序（缺失沉底，同日按 id 兜底）重新排序编号：
 * 第 i 条 version_of = 第 i-1 条 id、version_seq = i。因此：
 * - 任何顺序入库（先抓到第二轮、后抓到首轮）都收敛到正确链序；
 * - 重算幂等（值未变化的行不写库），重复抓取不漂移；
 * - 标题 / 机关变化导致条目离开旧分组时，旧分组同样重算，链自动缝合。
 *
 * 匹配键 = 标题规范化（src/lib/versions.ts）+ 同一发布机关；规范化无法表达为
 * 双方言交集内的 SQL，故候选按机关过滤后在应用层比对（收录量级为每月数十条，
 * 一次分组查询足够）。
 */

/** upsert 后的版本链同步入参；previous 仅更新路径提供（入库前的旧标题 / 机关）。 */
export interface NoticeVersionSyncInput {
  id: string;
  title: string;
  agency: string;
  previous?: { title: string; agency: string };
}

/**
 * 条目入库 / 更新后同步其所在版本链（以及因标题或机关变化而离开的旧链）。
 * 由 upsertNotice 自动调用，抓取管线无需感知。
 */
export async function syncNoticeVersionLinks(input: NoticeVersionSyncInput): Promise<void> {
  const newKey = normalizeTitleForVersionMatch(input.title);
  const oldKey = input.previous ? normalizeTitleForVersionMatch(input.previous.title) : null;
  const leftOldGroup =
    input.previous !== undefined &&
    (input.previous.agency !== input.agency || oldKey !== newKey);

  // 标题 / 机关变化导致条目离开旧版本链：先重算旧链（不含本行），链自动缝合
  if (leftOldGroup && oldKey !== null && input.previous) {
    await relinkVersionGroup(oldKey, input.previous.agency);
  }

  if (newKey === null) {
    // 规范化后无有效主体：不参与任何版本链，清掉可能残留的关联
    const db = await getDb();
    await db
      .update(notices)
      .set({ versionOf: null, versionSeq: null })
      .where(eq(notices.id, input.id));
    return;
  }
  await relinkVersionGroup(newKey, input.agency);
}

/**
 * 重算一个版本分组（同规范化标题 + 同机关）的链序：按发布日期升序编号，
 * 只写值发生变化的行（幂等）。
 */
async function relinkVersionGroup(titleKey: string, agency: string): Promise<void> {
  const db = await getDb();
  const rows = await db
    .select({
      id: notices.id,
      title: notices.title,
      publishedAt: notices.publishedAt,
      versionOf: notices.versionOf,
      versionSeq: notices.versionSeq,
    })
    .from(notices)
    .where(eq(notices.agency, agency));

  const members = rows
    .filter((row) => normalizeTitleForVersionMatch(row.title) === titleKey)
    .sort(compareByRoundOrder);

  for (const [index, member] of members.entries()) {
    const expectedVersionOf = index === 0 ? null : members[index - 1].id;
    const expectedVersionSeq = index + 1;
    if (member.versionOf === expectedVersionOf && member.versionSeq === expectedVersionSeq) {
      continue;
    }
    await db
      .update(notices)
      .set({ versionOf: expectedVersionOf, versionSeq: expectedVersionSeq })
      .where(eq(notices.id, member.id));
  }
}

/** 链序比较：发布日期升序，缺失沉底；同日按 id 兜底保证确定性。 */
function compareByRoundOrder(
  a: { id: string; publishedAt: string | null },
  b: { id: string; publishedAt: string | null },
): number {
  const pa = a.publishedAt ?? '9999-12-31';
  const pb = b.publishedAt ?? '9999-12-31';
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
