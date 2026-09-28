import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { attachmentBudgetFor } from '../../src/sources/attachment-budget.ts';
import { npcLawDraftsAdapter } from '../../src/sources/adapters/npc.ts';

/**
 * 单元：按源的附件预算（issue #86 第十八节）。
 *
 * 为什么要这一层：单个附件的上限与超时是全站预算（`ATTACHMENT_MAX_BYTES` 缺省 4 MB /
 * `CRAWL_TIMEOUT_MS` 缺省 15 秒），而人大网的草案 PDF 实测有一条 **43,254,307 字节**、
 * 下载约 40 秒 —— 两处都会把它挡在门外，而失败长成"下载失败"的样子（看起来像文件坏了）。
 *
 * 这条用例钉的是**判据**：同一个 43,254,307 字节，落在 npc 上要放行、落在别的源上要拒绝。
 * 数字直接用实测值，不用凑出来的数 —— 换一个大小就测不出"这两条墙分别在哪儿"。
 */

/** 实测：道路交通安全法（修订草案）.PDF */
const REAL_DRAFT_BYTES = 43_254_307;
const GLOBAL_MAX_BYTES = 4 * 1024 * 1024;
const GLOBAL_TIMEOUT_MS = 15_000;

/** 假的适配器列表：只有 id 与 fetch 参与判定，其余字段与本用例无关。 */
const fakeAdapter = (id, fetch) => ({ id, fetch });

function budgetFor(sourceId, adapters, overrides = {}) {
  return attachmentBudgetFor({
    sourceId,
    adapters,
    globalMaxBytes: GLOBAL_MAX_BYTES,
    globalTimeoutMs: GLOBAL_TIMEOUT_MS,
    ...overrides,
  });
}

describe('按源的附件预算', () => {
  it('未声明的源用全局值（字节与超时各一条）', () => {
    const adapters = [fakeAdapter('mee', undefined), fakeAdapter('samr', { timeoutMs: 30_000 })];
    assert.deepEqual(budgetFor('mee', adapters), {
      maxBytes: GLOBAL_MAX_BYTES,
      timeoutMs: GLOBAL_TIMEOUT_MS,
      maxBytesPerSource: false,
    });
    // `timeoutMs` 是**页面**超时，不该被附件下载借用：它没声明附件预算，就还是全局那两条
    assert.deepEqual(budgetFor('samr', adapters), {
      maxBytes: GLOBAL_MAX_BYTES,
      timeoutMs: GLOBAL_TIMEOUT_MS,
      maxBytesPerSource: false,
    });
  });

  it('源不在注册表里 / sourceId 为空时同样退回全局值（不猜）', () => {
    const adapters = [fakeAdapter('npc', { attachmentBudget: { maxBytes: 64 * 1024 * 1024 } })];
    for (const sourceId of ['govcn', null]) {
      assert.deepEqual(budgetFor(sourceId, adapters), {
        maxBytes: GLOBAL_MAX_BYTES,
        timeoutMs: GLOBAL_TIMEOUT_MS,
        maxBytesPerSource: false,
      });
    }
  });

  it('声明了哪一项就覆盖哪一项，另一项仍取全局（半套声明不许把另一条也改掉）', () => {
    const onlyBytes = [fakeAdapter('npc', { attachmentBudget: { maxBytes: 64 * 1024 * 1024 } })];
    assert.deepEqual(budgetFor('npc', onlyBytes), {
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: GLOBAL_TIMEOUT_MS,
      maxBytesPerSource: true,
    });
    const onlyTimeout = [fakeAdapter('npc', { attachmentBudget: { timeoutMs: 120_000 } })];
    assert.deepEqual(budgetFor('npc', onlyTimeout), {
      maxBytes: GLOBAL_MAX_BYTES,
      timeoutMs: 120_000,
      // 字节这一项仍来自全站 —— 说超限原因时必须说"单个附件"，不能说"本源的"
      maxBytesPerSource: false,
    });
  });

  it('npc 实测那份 41 MB 草案：npc 放行、其余源拒绝', () => {
    const accept = (budget) => REAL_DRAFT_BYTES <= budget.maxBytes;
    assert.equal(accept(budgetFor('npc', [npcLawDraftsAdapter])), true, 'npc 应按源放宽到 64 MB');
    assert.equal(
      accept(budgetFor('mee', [npcLawDraftsAdapter, fakeAdapter('mee', undefined)])),
      false,
      '别的源不该因为 npc 的声明而跟着放宽 —— 那正是"抬全局"要避免的事',
    );
  });

  it('npc 声明的两条预算成对出现，且都落在解析结果里', () => {
    const declared = npcLawDraftsAdapter.fetch?.attachmentBudget;
    assert.ok(declared, 'npc 必须声明按源附件预算（只声明附件不改上限 = 那条草案会以"下载失败"收场）');
    assert.equal(declared.maxBytes, 64 * 1024 * 1024);
    // 只抬字节不抬时间，41 MB 会在全局 15 秒上被掐断；120 秒 = 实测 40 秒的 3 倍余量
    assert.equal(declared.timeoutMs, 120_000);
    const budget = budgetFor('npc', [npcLawDraftsAdapter]);
    assert.equal(budget.timeoutMs, declared.timeoutMs);
  });

  it('真实夹具里的 size 与"41 MB"这个结论对得上（数字不是抄来的）', () => {
    // 夹具是逐字节照抄的服务器响应；这条防的是"以后有人改了夹具，而用例里的数字没跟着改"
    const payload = JSON.parse(
      readFileSync('fixtures/npc/flca/ff8081819ff54ab801a03d624f823cc3/fjxx/index.json', 'utf8'),
    );
    assert.equal(Number(payload.size), REAL_DRAFT_BYTES);
  });
});
