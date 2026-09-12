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
 * - 已退订邮箱：重新订阅 —— 重置为待确认并换发新 token（绝不自动复活）；
 * - 已确认邮箱：只更新规则（订阅继续生效），不重发确认邮件。
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

  if (existingRows.length === 0) {
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
    await db.insert(subscriptions).values(row);
    return {
      subscription: toSubscriptionRecord(row),
      outcome: 'created',
    };
  }

  const existing = existingRows[0];
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

  // 待确认 / 已退订：更新规则并重置为新的待确认订阅（轮换全部 token）
  const confirmToken = newToken();
  const unsubscribeToken = newToken();
  await db
    .update(subscriptions)
    .set({
      keywordsJson: JSON.stringify(input.keywords),
      categoriesJson: JSON.stringify(input.categories),
      confirmed: 0,
      confirmToken,
      unsubscribeToken,
      confirmedAt: null,
      unsubscribedAt: null,
      updatedAt: nowIso,
    })
    .where(eq(subscriptions.id, existing.id));
  return {
    subscription: toSubscriptionRecord({
      ...existing,
      keywordsJson: JSON.stringify(input.keywords),
      categoriesJson: JSON.stringify(input.categories),
      confirmed: 0,
      confirmToken,
      unsubscribeToken,
      confirmedAt: null,
      unsubscribedAt: null,
      updatedAt: nowIso,
    }),
    outcome: wasUnsubscribed ? 'resubscribed' : 'pending-refreshed',
  };
}

export type ConfirmResult = 'confirmed' | 'unsubscribed' | 'invalid';

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

/** 按邮箱取订阅（E2E 与排查用）；不存在返回 null。 */
export async function getSubscriptionByEmail(
  email: string,
): Promise<SubscriptionRecord | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, email))
    .limit(1);
  return rows.length > 0 ? toSubscriptionRecord(rows[0]) : null;
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
