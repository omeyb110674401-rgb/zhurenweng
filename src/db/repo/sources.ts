import { eq } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { sources } from '../schema/sqlite.ts';
import type { SourceRecord } from '../types.ts';

/** 抓取管线维护的源登记信息（幂等 upsert 输入）。 */
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
 * 调度配置（scheduleConfigJson）不由抓取管线覆盖，保留已有值。
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

/** 按源 ID 取源记录；不存在返回 null（详情页展示来源名称用）。 */
export async function getSourceById(id: string): Promise<SourceRecord | null> {
  const db = await getDb();
  const rows = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    scheduleConfig: safeParseJsonObject(row.scheduleConfigJson),
    healthy: row.healthy === 1,
    lastSuccessAt: row.lastSuccessAt,
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
