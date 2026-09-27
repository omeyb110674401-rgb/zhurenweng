import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { subscriptions } from '../schema/sqlite.ts';
import { isSubscribableAudience } from '../../lib/audience.ts';
import type { NoticeAudience } from '../../lib/audience.ts';
import type { SubscriptionRecord, SubscriptionRules, SubscriptionScope } from '../types.ts';

/**
 * 订阅仓库（issue #7）：double opt-in 的持久化层。
 *
 * - 邮箱唯一：重复提交同邮箱更新规则而非重复建行；
 * - 确认 / 退订按邮件链接中的 token 定位订阅；
 * - 退订只置 unsubscribed_at（行保留），已退订的邮箱再次订阅时重置为待确认。
 */

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function toSubscriptionRecord(row: typeof subscriptions.$inferSelect): SubscriptionRecord {
  return {
    id: row.id,
    email: row.email,
    keywords: safeParseArray(row.keywordsJson),
    categories: safeParseArray(row.categoriesJson),
    agencies: safeParseArray(row.agenciesJson),
    audiences: safeParseAudiences(row.audiencesJson),
    scope: row.scope === 'all' ? 'all' : 'rules',
    pending: parsePendingRules(row.pendingRulesJson),
    confirmed: row.confirmed === 1,
    confirmToken: row.confirmToken,
    unsubscribeToken: row.unsubscribeToken,
    confirmedAt: row.confirmedAt,
    unsubscribedAt: row.unsubscribedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 受众面列的读取（issue #84）：**只认已知取值，读到别的一律丢掉**。
 *
 * 两条路都各有一个坏结果，选的是**可见**的那一个：丢掉未知值 = 这一档收窄失效
 * ⇒ 订阅者**多收**几封（他会发现，我们查得到）；保留未知值 = 这个条件永远不命中
 * ⇒ 他**一封都收不到**且没有任何报错（最坏的一种静默）。受众面是收窄条件，
 * 放宽是安全方向，收死不是。
 *
 * 取值只可能从本站表单来（路由按白名单过滤），所以走到这里说明分类体系被改过名
 * —— 那时该做的是一次显式迁移，而不是让读侧悄悄表达旧语义。
 */
function safeParseAudiences(text: string): NoticeAudience[] {
  return safeParseArray(text).filter(isSubscribableAudience);
}

function safeParseArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** 解析待确认规则；NULL / 形状不对都当"没有待确认改动"（绝不让脏数据当成生效规则）。 */
function parsePendingRules(text: string | null): SubscriptionRules | null {
  if (text === null || text === '') return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const list = (key: string): string[] =>
      Array.isArray(record[key]) ? (record[key] as unknown[]).map((item) => String(item)) : [];
    return {
      keywords: list('keywords'),
      categories: list('categories'),
      agencies: list('agencies'),
      // 待确认列与正式列共用同一份过滤：两边都只认可订阅的两档，否则"确认一次之后
      // 规则里多了个永远不会命中的值"这种事会只在待确认那一支发生。
      audiences: list('audiences').filter(isSubscribableAudience),
      scope: record.scope === 'all' ? 'all' : 'rules',
    };
  } catch {
    return null;
  }
}

/** 一份输入的规则部分（正式列与待确认列共用同一份序列化，别写两遍）。 */
type RulesInput = Pick<
  UpsertSubscriptionInput,
  'keywords' | 'categories' | 'agencies' | 'audiences' | 'scope'
>;

function serializeRules(rules: RulesInput): string {
  return JSON.stringify({
    keywords: rules.keywords,
    categories: rules.categories,
    agencies: rules.agencies,
    audiences: rules.audiences,
    scope: rules.scope,
  });
}

/** upsert 结果：四种取值都需要发送确认邮件（含已确认订阅的改动）。 */
export type SubscriptionUpsertOutcome =
  | 'created'
  | 'pending-refreshed'
  | 'resubscribed'
  /**
   * 已确认订阅改了规则：新规则进待确认列，**必须再确认一次才生效**（issue #60 第 4 刀）。
   * 旧名字 `confirmed-updated` 描述的是"直接改生效"，那个行为正是要修掉的东西。
   */
  | 'confirmed-pending';

export interface UpsertSubscriptionInput {
  email: string;
  keywords: string[];
  categories: string[];
  /** 发布机关规则（issue #60 第 2 刀，已归一的机关名） */
  agencies: string[];
  /** 受众面收窄条件（issue #84）：空数组 = 不限 */
  audiences: NoticeAudience[];
  /** 订阅范围（issue #60）：'rules' 按条件 / 'all' 全部新公示 */
  scope: SubscriptionScope;
  now: Date;
}

/**
 * 规则列的落库形状 —— upsert 的三条写入路径（新建 / 已确认改规则 / 待确认改规则）
 * **共用这一份**。分家的后果是这个仓库反复记过的那种：一处写了 agencies，
 * 另一处忘了写，于是"重新提交订阅"会静默把机关规则清掉。
 */
function ruleColumns(
  input: Pick<UpsertSubscriptionInput, 'keywords' | 'categories' | 'agencies' | 'audiences' | 'scope'>,
) {
  return {
    keywordsJson: JSON.stringify(input.keywords),
    categoriesJson: JSON.stringify(input.categories),
    agenciesJson: JSON.stringify(input.agencies),
    audiencesJson: JSON.stringify(input.audiences),
    scope: input.scope,
  };
}

/**
 * 按邮箱 upsert 订阅（double opt-in）：
 * - 新邮箱：创建待确认订阅（confirmed=0），签发确认 / 退订 token；
 * - 待确认邮箱：更新规则并轮换确认 token（旧确认链接随即失效），重发确认邮件；
 * - 已退订邮箱：重新订阅 —— 重置为待确认并换发新确认 token（绝不自动复活）；
 * - 已确认邮箱：只更新规则（订阅继续生效），不重发确认邮件。
 *
 * 并发（issue #52）：先 select 再 insert 是 TOCTOU —— 双击 / 重试 / 扫描器同时提交
 * 同一新邮箱时两个请求都会走到 insert，后到者撞 email 唯一约束。公开端点不能因此
 * 500（#51 修掉了「非表单体 500」，这是同一个目标下的另一条路径），所以 insert 用
 * `ON CONFLICT DO NOTHING`：落空即说明另一个请求刚建了行，回落到更新分支继续。
 * 用 ON CONFLICT 而不是捕获异常，是因为唯一约束冲突的报错形状在两种方言里不同
 * （PG 的 SQLSTATE 23505 / SQLite 的字符串消息），按方言分支会多出第二处方言代码
 * （ADR-0001 只允许 periodDaysExpr 那一处）。
 */
export async function upsertSubscriptionRules(input: UpsertSubscriptionInput): Promise<{
  subscription: SubscriptionRecord;
  outcome: SubscriptionUpsertOutcome;
}> {
  const db = await getDb();
  const nowIso = input.now.toISOString();
  const existingRows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, input.email))
    .limit(1);

  if (existingRows.length > 0) {
    return applyRulesToExisting(existingRows[0], input, nowIso);
  }

  const row = {
    id: randomUUID(),
    email: input.email,
    ...ruleColumns(input),
    // 新订阅没有"上一版规则"要保护：规则直接进正式列，待确认列为空
    pendingRulesJson: null,
    confirmed: 0,
    confirmToken: newToken(),
    unsubscribeToken: newToken(),
    confirmedAt: null,
    unsubscribedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const inserted = await db
    .insert(subscriptions)
    .values(row)
    .onConflictDoNothing({ target: subscriptions.email })
    .returning({ id: subscriptions.id });
  if (inserted.length > 0) {
    return {
      subscription: toSubscriptionRecord(row),
      outcome: 'created',
    };
  }

  // 冲突落空：同一邮箱的行在两次查询之间被另一个请求建出来了 → 走更新分支
  const raced = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, input.email))
    .limit(1);
  if (raced.length === 0) {
    throw new Error(`订阅冲突后未找到既有行（email=${input.email}）`);
  }
  return applyRulesToExisting(raced[0], input, nowIso);
}

/** 已存在行的规则更新：已确认只改规则，待确认 / 已退订则重置为待确认并重发确认邮件。 */
async function applyRulesToExisting(
  existing: typeof subscriptions.$inferSelect,
  input: UpsertSubscriptionInput,
  nowIso: string,
): Promise<{ subscription: SubscriptionRecord; outcome: SubscriptionUpsertOutcome }> {
  const db = await getDb();
  const wasUnsubscribed = existing.unsubscribedAt !== null;
  const wasConfirmed = existing.confirmed === 1 && !wasUnsubscribed;

  if (wasConfirmed) {
    // 已确认订阅的改动**不直接生效**：写进待确认列 + 轮换确认 token + 重发确认邮件。
    // 旧行为是直接改正式列且不发信，于是"知道某人邮箱"就能静默改写其订阅
    // （FOLLOWUPS #52 挂账）；限流挡不住有意的重复提交，"必须再确认一次"才挡得住。
    const confirmToken = newToken();
    const updated = {
      ...existing,
      pendingRulesJson: serializeRules(input),
      confirmToken,
      updatedAt: nowIso,
    };
    await db
      .update(subscriptions)
      .set({
        pendingRulesJson: updated.pendingRulesJson,
        confirmToken,
        updatedAt: nowIso,
      })
      .where(eq(subscriptions.id, existing.id));
    return {
      subscription: toSubscriptionRecord(updated),
      outcome: 'confirmed-pending',
    };
  }

  /**
   * 待确认 / 已退订：更新规则并重置为新的待确认订阅 —— **只轮换确认 token**。
   *
   * 退订 token 保持不变（issue #52）：它印在每一封发出的邮件底部，轮换会让**旧邮件
   * 里的退订链接全部失效**（点开只得到「退订链接无效」），而合规口径是「每封邮件都
   * 可退订」。它不是身份凭据（退订本就允许任何持有链接的人执行），保持稳定没有额外
   * 风险 —— 而轮换有真实代价。
   */
  const confirmToken = newToken();
  const updated = {
    ...existing,
    ...ruleColumns(input),
    // 待确认 / 已退订的邮箱重新提交：这次的内容就是它要确认的全部内容，
    // 旧的待套用改动必须清掉，否则会留下一个"下次确认时套用哪份"的歧义。
    pendingRulesJson: null,
    confirmed: 0,
    confirmToken,
    confirmedAt: null,
    unsubscribedAt: null,
    updatedAt: nowIso,
  };
  await db
    .update(subscriptions)
    .set({
      ...ruleColumns(input),
      confirmed: 0,
      confirmToken,
      confirmedAt: null,
      unsubscribedAt: null,
      updatedAt: nowIso,
    })
    .where(eq(subscriptions.id, existing.id));
  return {
    subscription: toSubscriptionRecord(updated),
    outcome: wasUnsubscribed ? 'resubscribed' : 'pending-refreshed',
  };
}

export type ConfirmResult = 'confirmed' | 'unsubscribed' | 'invalid';

/** 确认 token 的只读状态：确认页据此渲染按钮，不写任何数据。 */
export type ConfirmTokenStatus = 'confirmable' | 'confirmed' | 'unsubscribed' | 'invalid';

/**
 * 确认 token 的**只读**状态（issue #52）：与 `unsubscribeTokenStatus` 同一个理由 ——
 * 邮件安全网关会预取邮件里的链接，所以「打开确认页」必须不写库，确认动作要用户
 * 显式 POST（见 app/subscribe/confirm/page.tsx 的注释）。
 */
export async function confirmTokenStatus(token: string): Promise<ConfirmTokenStatus> {
  if (token.length === 0) return 'invalid';
  const db = await getDb();
  const rows = await db
    .select({
      confirmed: subscriptions.confirmed,
      unsubscribedAt: subscriptions.unsubscribedAt,
      pendingRulesJson: subscriptions.pendingRulesJson,
    })
    .from(subscriptions)
    .where(eq(subscriptions.confirmToken, token))
    .limit(1);
  if (rows.length === 0) return 'invalid';
  if (rows[0].unsubscribedAt !== null) return 'unsubscribed';
  // 「已确认但有待套用改动」必须仍然算可确认 —— 否则确认页不给按钮，
  // 用户改的规则永远无法生效（issue #60 第 4 刀新增的这条路径就堵死在这里）。
  if (rows[0].confirmed === 1 && parsePendingRules(rows[0].pendingRulesJson) === null) {
    return 'confirmed';
  }
  return 'confirmable';
}

/**
 * 按退订 token 只读取出订阅（issue #60 第 4 刀：「查看或修改我的订阅」入口预填用）。
 *
 * 只读 —— 与 `unsubscribeTokenStatus` 同一条理由：邮件安全网关会预取邮件里的链接，
 * 打开页面绝不能改数据。token 无效返回 null，页面按"普通订阅页"渲染。
 */
export async function findSubscriptionByUnsubscribeToken(
  token: string,
): Promise<SubscriptionRecord | null> {
  if (token.length === 0) return null;
  const db = await getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.unsubscribeToken, token))
    .limit(1);
  return rows.length === 0 ? null : toSubscriptionRecord(rows[0]);
}

/** 按确认 token 确认订阅（幂等）；已退订的订阅不可复活，token 不存在返回 invalid。 */
export async function confirmSubscriptionByToken(token: string): Promise<ConfirmResult> {
  if (token.length === 0) return 'invalid';
  const db = await getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.confirmToken, token))
    .limit(1);
  if (rows.length === 0) return 'invalid';
  const row = rows[0];
  if (row.unsubscribedAt !== null) return 'unsubscribed';
  const pending = parsePendingRules(row.pendingRulesJson);
  if (row.confirmed === 1 && pending === null) return 'confirmed';

  // 有待确认改动 ⇒ 确认这一刻才套用（issue #60 第 4 刀）。没有则维持原规则，
  // 只做首次确认。**已确认 + 有待确认**这一支是关键：它以前会在这里直接 return，
  // 于是"改规则再确认"永远不生效。
  const applied = pending ?? {
    keywords: safeParseArray(row.keywordsJson),
    categories: safeParseArray(row.categoriesJson),
    agencies: safeParseArray(row.agenciesJson),
    audiences: safeParseAudiences(row.audiencesJson),
    scope: row.scope === 'all' ? ('all' as const) : ('rules' as const),
  };
  await db
    .update(subscriptions)
    .set({
      ...ruleColumns(applied),
      pendingRulesJson: null,
      confirmed: 1,
      confirmedAt: row.confirmedAt ?? new Date().toISOString(),
    })
    .where(eq(subscriptions.id, row.id));
  return 'confirmed';
}

/**
 * 退订 token 的**只读**状态（issue #34）：确认页据此决定渲染确认表单还是「已退订」，
 * 不改任何数据 —— 退订必须由用户显式提交 POST 完成（见 /unsubscribe/one-click 的注释）。
 */
export async function unsubscribeTokenStatus(
  token: string,
): Promise<'confirmable' | 'unsubscribed' | 'invalid'> {
  if (token.length === 0) return 'invalid';
  const db = await getDb();
  const rows = await db
    .select({ unsubscribedAt: subscriptions.unsubscribedAt })
    .from(subscriptions)
    .where(eq(subscriptions.unsubscribeToken, token))
    .limit(1);
  if (rows.length === 0) return 'invalid';
  return rows[0].unsubscribedAt === null ? 'confirmable' : 'unsubscribed';
}

/** 按退订 token 一键退订（幂等，立即生效）；token 不存在返回 invalid。 */
export async function unsubscribeByToken(token: string): Promise<'done' | 'invalid'> {
  if (token.length === 0) return 'invalid';
  const db = await getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.unsubscribeToken, token))
    .limit(1);
  if (rows.length === 0) return 'invalid';
  if (rows[0].unsubscribedAt === null) {
    await db
      .update(subscriptions)
      .set({ unsubscribedAt: new Date().toISOString() })
      .where(eq(subscriptions.id, rows[0].id));
  }
  return 'done';
}

/** 提醒任务的收件人：已确认且未退订的订阅。未确认的订阅绝不接收任何提醒。 */
export async function listActiveSubscriptions(): Promise<SubscriptionRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.confirmed, 1), isNull(subscriptions.unsubscribedAt)));
  return rows.map(toSubscriptionRecord);
}
