import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { subscriptions } from '../schema/sqlite.ts';
import type { SubscriptionRecord } from '../types.ts';

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
    confirmed: row.confirmed === 1,
    confirmToken: row.confirmToken,
    unsubscribeToken: row.unsubscribeToken,
    confirmedAt: row.confirmedAt,
    unsubscribedAt: row.unsubscribedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParseArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** upsert 结果：created / pending-refreshed / resubscribed 需要发送确认邮件，confirmed-updated 不需要。 */
export type SubscriptionUpsertOutcome =
  | 'created'
  | 'pending-refreshed'
  | 'resubscribed'
  | 'confirmed-updated';

export interface UpsertSubscriptionInput {
  email: string;
  keywords: string[];
  categories: string[];
  now: Date;
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
    keywordsJson: JSON.stringify(input.keywords),
    categoriesJson: JSON.stringify(input.categories),
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
    await db
      .update(subscriptions)
      .set({
        keywordsJson: JSON.stringify(input.keywords),
        categoriesJson: JSON.stringify(input.categories),
        updatedAt: nowIso,
      })
      .where(eq(subscriptions.id, existing.id));
    return {
      subscription: toSubscriptionRecord({
        ...existing,
        keywordsJson: JSON.stringify(input.keywords),
        categoriesJson: JSON.stringify(input.categories),
        updatedAt: nowIso,
      }),
      outcome: 'confirmed-updated',
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
    keywordsJson: JSON.stringify(input.keywords),
    categoriesJson: JSON.stringify(input.categories),
    confirmed: 0,
    confirmToken,
    confirmedAt: null,
    unsubscribedAt: null,
    updatedAt: nowIso,
  };
  await db
    .update(subscriptions)
    .set({
      keywordsJson: updated.keywordsJson,
      categoriesJson: updated.categoriesJson,
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
    .select({ confirmed: subscriptions.confirmed, unsubscribedAt: subscriptions.unsubscribedAt })
    .from(subscriptions)
    .where(eq(subscriptions.confirmToken, token))
    .limit(1);
  if (rows.length === 0) return 'invalid';
  if (rows[0].unsubscribedAt !== null) return 'unsubscribed';
  return rows[0].confirmed === 1 ? 'confirmed' : 'confirmable';
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
  if (rows[0].unsubscribedAt !== null) return 'unsubscribed';
  if (rows[0].confirmed === 1) return 'confirmed';
  await db
    .update(subscriptions)
    .set({ confirmed: 1, confirmedAt: new Date().toISOString() })
    .where(eq(subscriptions.id, rows[0].id));
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
