import { asc, eq } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { sources } from '../schema/sqlite.ts';
import type { SourceRecord } from '../types.ts';

/**
 * 抓取管线维护的源登记信息（幂等 upsert 输入）。
 */
export interface UpsertSourceInput {
  id: string;
  name: string;
  adapterType: string;
  healthy: boolean;
  /** undefined = 保留已有值（抓取失败时不清空最近成功时间） */
  lastSuccessAt?: string | null;
}

/**
 * 幂等登记源（抓取成功 / 失败都写入，维护健康状态与最近成功时间）。
 * 调度配置（scheduleConfigJson）、启用开关与错误列不被本函数覆盖；
 * 失败路径的错误信息用 recordSourceFailure 单独登记。
 */
export async function upsertSource(input: UpsertSourceInput): Promise<void> {
  const db = await getDb();
  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.id, input.id))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(sources)
      .set({
        name: input.name,
        adapterType: input.adapterType,
        healthy: input.healthy ? 1 : 0,
        ...(input.lastSuccessAt !== undefined ? { lastSuccessAt: input.lastSuccessAt } : {}),
      })
      .where(eq(sources.id, input.id));
    return;
  }

  await db.insert(sources).values({
    id: input.id,
    name: input.name,
    adapterType: input.adapterType,
    scheduleConfigJson: '{}',
    healthy: input.healthy ? 1 : 0,
    lastSuccessAt: input.lastSuccessAt ?? null,
  });
}

/** 抓取失败路径：登记不健康状态与最近一次错误信息 / 时间（成功不清空错误列）。 */
export async function recordSourceFailure(input: {
  id: string;
  name: string;
  adapterType: string;
  error: string;
  now: string;
}): Promise<void> {
  const db = await getDb();
  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.id, input.id))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(sources)
      .set({
        name: input.name,
        adapterType: input.adapterType,
        healthy: 0,
        lastErrorMessage: input.error,
        lastErrorAt: input.now,
      })
      .where(eq(sources.id, input.id));
    return;
  }

  await db.insert(sources).values({
    id: input.id,
    name: input.name,
    adapterType: input.adapterType,
    scheduleConfigJson: '{}',
    healthy: 0,
    lastErrorMessage: input.error,
    lastErrorAt: input.now,
  });
}

/** 全量源列表（管理后台源健康看板用），按源 ID 排序保证展示稳定。 */
export async function listSources(): Promise<SourceRecord[]> {
  const db = await getDb();
  const rows = await db.select().from(sources).orderBy(asc(sources.id));
  return rows.map(toSourceRecord);
}

/** 按源 ID 取源记录；不存在返回 null（详情页展示来源名称用）。 */
export async function getSourceById(id: string): Promise<SourceRecord | null> {
  const db = await getDb();
  const rows = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  return rows.length > 0 ? toSourceRecord(rows[0]) : null;
}

/** 源启用 / 停用（issue #12 源管理：停用后抓取任务跳过该源）。源不存在返回 false。 */
export async function setSourceEnabled(id: string, enabled: boolean): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.id, id))
    .limit(1);
  if (existing.length === 0) return false;
  await db.update(sources).set({ enabled: enabled ? 1 : 0 }).where(eq(sources.id, id));
  return true;
}

function toSourceRecord(row: typeof sources.$inferSelect): SourceRecord {
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    scheduleConfig: safeParseJsonObject(row.scheduleConfigJson),
    healthy: row.healthy === 1,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorMessage: row.lastErrorMessage,
    lastErrorAt: row.lastErrorAt,
    enabled: row.enabled === 1,
  };
}

function safeParseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
