import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { npcDraftAttachmentsEnabled, npcLawDraftsAdapter } from '../../src/sources/adapters/npc.ts';

/**
 * 单元：npc 草案电子文档的声明（issue #86 第十八节）。
 *
 * 两件事分开测：
 * 1. **开关**（`NPC_DRAFT_ATTACHMENTS`）决定要不要去问附件清单接口 —— 关着时
 *    `attachmentListUrl` 返回 null，抓取层因此**一个请求都不发**（"部署代码"与
 *    "开始拉 41 MB 的文件"是两次独立的决定，这条就是它的量具）；
 * 2. **解析**判据只看一件事：官方接口给了文件名才声明附件。文件名不臆造、地址不猜 ——
 *    接口里那个 `path`（/flca/<hash>.PDF）实测一律 404，能取到的是同目录的 attachment.pdf。
 *
 * 夹具是服务器响应的**逐字节照抄**（618 字节），所以这里断言的文件名是官方的原文。
 */

const LID = 'ff8081819ff54ab801a03d624f823cc3';
const PAGE_URL = `http://www.npc.gov.cn/flcaw/userIndex.html?lid=${LID}`;
const FJXX_PATH = `fixtures/npc/flca/${LID}/fjxx/index.json`;

/** 真实响应原文（含 `_snapshot` 说明块，与服务器上那份的差别只有说明块）。 */
function realPayload() {
  return readFileSync(FJXX_PATH, 'utf8');
}

const notice = {
  title: '道路交通安全法（修订草案）征求意见',
  agency: '全国人大常委会法制工作委员会',
  url: PAGE_URL,
  publishedAt: '2026-08-28',
  deadlineAt: '2026-10-12',
  bodyText: null,
  attachments: [],
};

/** 在给定开关值下执行，结束后精确还原（不污染同进程其它用例）。 */
function withKnob(value, fn) {
  const saved = process.env.NPC_DRAFT_ATTACHMENTS;
  try {
    if (value === undefined) delete process.env.NPC_DRAFT_ATTACHMENTS;
    else process.env.NPC_DRAFT_ATTACHMENTS = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NPC_DRAFT_ATTACHMENTS;
    else process.env.NPC_DRAFT_ATTACHMENTS = saved;
  }
}

describe('npc 草案电子文档：开关', () => {
  it('缺省关：一个请求都不发（attachmentListUrl 返回 null）', () => {
    withKnob(undefined, () => {
      assert.equal(npcDraftAttachmentsEnabled(), false);
      assert.equal(
        npcLawDraftsAdapter.attachmentListUrl(notice),
        null,
        '关着的时候不该给出地址 —— 给出了就等于每轮多打几百 MB 的请求',
      );
    });
  });

  it('空串按"未设置"处理（compose 的 ${VAR:-} 会传空串进来，留空不该崩）', () => {
    withKnob('', () => assert.equal(npcDraftAttachmentsEnabled(), false));
  });

  it('打开：给出 <flcaw>/flca/<lid>/fjxx/ 的地址', () => {
    withKnob('on', () => {
      assert.equal(npcDraftAttachmentsEnabled(), true);
      assert.equal(
        npcLawDraftsAdapter.attachmentListUrl(notice),
        `http://www.npc.gov.cn/flcaw/flca/${LID}/fjxx/`,
      );
    });
  });

  it('写错档位当场抛错，不静默当成关（否则"开关打开了"这句话没法证伪）', () => {
    for (const bad of ['yes', 'true', '1', 'offf', 'onn', '打开']) {
      withKnob(bad, () => {
        assert.throws(
          () => npcDraftAttachmentsEnabled(),
          /NPC_DRAFT_ATTACHMENTS 不是合法档位/,
          `「${bad}」应被拒绝`,
        );
      });
    }
  });

  it('大小写与空白宽容：ON / on / " on " 都是打开', () => {
    for (const good of ['ON', 'On', ' on ']) {
      withKnob(good, () => assert.equal(npcDraftAttachmentsEnabled(), true, `「${good}」应当算打开`));
    }
  });

  it('附件地址相对条目页推导（生产落在真实站点，E2E 落在 fixture 目录内）', () => {
    withKnob('on', () => {
      const declared = npcLawDraftsAdapter.parseAttachmentList(realPayload(), PAGE_URL);
      assert.equal(declared.length, 1);
      assert.equal(declared[0].url, `http://www.npc.gov.cn/flcaw/flca/${LID}/attachment.pdf`);
      // 相对推导这件事要能一眼看出来：换一个基点，路径跟着落在那个基点下
      const fixturePage = `http://127.0.0.1:9999/npc/userIndex.html?lid=${LID}`;
      assert.equal(
        npcLawDraftsAdapter.parseAttachmentList(realPayload(), fixturePage)[0].url,
        `http://127.0.0.1:9999/npc/flca/${LID}/attachment.pdf`,
      );
    });
  });
});

describe('npc 草案电子文档：解析判据', () => {
  it('用官方文件名（不臆造、不用标题拼）', () => {
    const declared = npcLawDraftsAdapter.parseAttachmentList(realPayload(), PAGE_URL);
    assert.deepEqual(declared, [
      { name: '道路交通安全法（修订草案）.PDF', url: `http://www.npc.gov.cn/flcaw/flca/${LID}/attachment.pdf` },
    ]);
  });

  it('接口里那个 path 不能当地址用（实测对机房 IP 一律 404）', () => {
    const payload = JSON.parse(realPayload());
    assert.match(payload.path, /^\/flca\/[0-9a-f]+\.PDF$/);
    const declared = npcLawDraftsAdapter.parseAttachmentList(realPayload(), PAGE_URL);
    assert.ok(
      !declared.some((item) => item.url.includes(payload.path)),
      '声明出去的地址必须是实测取得到的那个，不能是接口里那个 404 的 path',
    );
  });

  it('没有文件名 / 不是 JSON / 缺 lid 时返回空数组（宁可没有附件，也不要猜一个名字）', () => {
    const cases = [
      ['{}', PAGE_URL],
      ['{"fileName":"   "}', PAGE_URL],
      ['<html>502 Bad Gateway</html>', PAGE_URL],
      ['{"fileName":"某草案.PDF"}', 'http://www.npc.gov.cn/flcaw/userIndex.html'],
    ];
    for (const [payload, pageUrl] of cases) {
      assert.deepEqual(
        npcLawDraftsAdapter.parseAttachmentList(payload, pageUrl),
        [],
        `这份响应不该产出附件：${payload.slice(0, 40)}`,
      );
    }
  });
});
