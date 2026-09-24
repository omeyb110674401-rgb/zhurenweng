import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channelGuidance } from '../../src/lib/channel-guidance.ts';

/**
 * 单元（issue #64）：提交方式取不到时，页面该说哪一种"为什么"。
 *
 * 这一块的全部风险都在**说多**：把"本站没抓到"说成"原文没写"，读者就少跑一次原文、
 * 多等一个不会来的结果；把"附件读不出来"说成"附件里有"，等于承诺了没发生的事
 * （issue #22/#58 反复清掉的那类）。所以每种事实组合都要钉住结论，尤其钉住
 * 「不确定时不指向附件」。
 */

const NO_ATTACHMENTS = { total: 0, fedChars: 0, okFiles: 0 };

describe('issue #64：channelGuidance 的分支', () => {
  it('有渠道时不给说明（渠道块自己会说话，不需要一句"我没抽到"）', () => {
    assert.equal(
      channelGuidance({ hasChannels: true, bodyChars: 0, attachmentReport: NO_ATTACHMENTS }),
      null,
    );
  });

  it('正文为空与正文里没句式是两种事实，必须分开说', () => {
    assert.equal(
      channelGuidance({ hasChannels: false, bodyChars: 0, attachmentReport: NO_ATTACHMENTS }).reason,
      'no-body',
    );
    const withBody = channelGuidance({
      hasChannels: false,
      bodyChars: 4_200,
      attachmentReport: NO_ATTACHMENTS,
    });
    assert.equal(withBody.reason, 'not-in-body');
    assert.equal(withBody.bodyChars, 4_200, '字数要说出来：它是"我们确实读过这一页"的证据');
  });

  it('附件正文可读时才把读者指向附件（并给出份数）', () => {
    const readable = channelGuidance({
      hasChannels: false,
      bodyChars: 500,
      attachmentReport: { total: 3, fedChars: 8_000, okFiles: 3 },
    });
    assert.equal(readable.attachment, 'readable');
    assert.equal(readable.attachmentFiles, 3);
    // 影子档：抽到了正文但没喂给摘要 —— 附件仍然是"可以自己去读"的地方
    const shadow = channelGuidance({
      hasChannels: false,
      bodyChars: 500,
      attachmentReport: { total: 2, fedChars: 0, okFiles: 2 },
    });
    assert.equal(shadow.attachment, 'readable');
    assert.equal(shadow.attachmentFiles, 2);
  });

  it('附件读不出来时如实说不清，不假装附件里有答案', () => {
    const unreadable = channelGuidance({
      hasChannels: false,
      bodyChars: 500,
      attachmentReport: { total: 4, fedChars: 0, okFiles: 0, failures: { blocked: 4 } },
    });
    assert.equal(unreadable.attachment, 'unreadable');
    assert.equal(unreadable.attachmentFiles, 4);
  });

  it('没有附件时明说没有（读者就不会白等附件）', () => {
    assert.equal(
      channelGuidance({ hasChannels: false, bodyChars: 500, attachmentReport: NO_ATTACHMENTS })
        .attachment,
      'none',
    );
  });

  it('抽取还没跑到这一条 ≠ 没有附件：报 unknown，且不说附件里有', () => {
    const unknown = channelGuidance({
      hasChannels: false,
      bodyChars: 500,
      attachmentReport: null,
    });
    assert.equal(unknown.attachment, 'unknown');
    assert.equal(unknown.attachmentFiles, 0);
  });
});
