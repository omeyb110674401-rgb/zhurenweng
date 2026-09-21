import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearedSubscribeDraftCookie,
  decodeSubscribeDraft,
  encodeSubscribeDraft,
  hasDraftContent,
  subscribeDraftCookie,
  SUBSCRIBE_DRAFT_COOKIE,
} from '../../src/lib/subscribe-draft.ts';

/**
 * 单元测试（issue #53）：订阅表单草稿 cookie 的编解码。
 *
 * 为什么值得单测：这个 cookie 是**客户端可控输入**（浏览器可以随便改），页面拿它当
 * 表单默认值 —— 解码必须对任何形状的输入都安全返回，绝不能抛错打断渲染；同时它承载
 * 的是用户自己敲进去的邮箱与关键词，长度必须有上限（cookie 有 4KB 上限）。
 */

describe('issue #53：订阅草稿 cookie 的编解码', () => {
  it('往返一致：邮箱 / 关键词 / 领域都能原样取回', () => {
    const draft = { email: 'a@example.com', keywords: '噪声污染防治 医疗', categories: ['生态环境'] };
    const decoded = decodeSubscribeDraft(encodeSubscribeDraft(draft));
    assert.deepEqual(decoded, draft);
  });

  it('空草稿不写 cookie：全空时 hasDraftContent 为假、解码也返回 null', () => {
    const empty = { email: '', keywords: '', categories: [] };
    assert.equal(hasDraftContent(empty), false);
    assert.equal(decodeSubscribeDraft(encodeSubscribeDraft(empty)), null);
  });

  it('任一字段非空就算有内容（只填了关键词也要回填）', () => {
    assert.equal(hasDraftContent({ email: '', keywords: '噪声', categories: [] }), true);
    assert.equal(hasDraftContent({ email: '', keywords: '', categories: ['生态环境'] }), true);
  });

  it('客户端可控输入不会打断渲染：乱码 / 非 JSON / 形状不对一律返回 null', () => {
    for (const raw of ['', 'not-base64!!', '###', encodeURIComponent('{}'), btoa('[]'), btoa('"str"')]) {
      assert.equal(decodeSubscribeDraft(raw), null, `输入 ${JSON.stringify(raw)} 应安全返回 null`);
    }
    // 形状不对：字段类型错了就丢弃该字段，而不是整体报错
    const wrongTypes = Buffer.from(JSON.stringify({ email: 42, keywords: null, categories: 'x' })).toString('base64url');
    assert.equal(decodeSubscribeDraft(wrongTypes), null);
  });

  it('长度有上限（cookie 不该被超长输入撑爆）', () => {
    const decoded = decodeSubscribeDraft(
      encodeSubscribeDraft({
        email: `${'a'.repeat(400)}@example.com`,
        keywords: 'k'.repeat(900),
        categories: Array.from({ length: 50 }, (_value, index) => `c${index}`),
      }),
    );
    assert.ok(decoded !== null);
    assert.ok(decoded.email.length <= 254, `邮箱应截到 254 以内，实际 ${decoded.email.length}`);
    assert.ok(decoded.keywords.length <= 300, `关键词应截到 300 以内，实际 ${decoded.keywords.length}`);
    assert.equal(decoded.categories.length, 20, '领域最多保留 20 个');
  });

  it('Set-Cookie 值：HttpOnly + 路径限定在订阅页 + 刻意不带 Secure', () => {
    const value = subscribeDraftCookie({ email: 'a@example.com', keywords: '', categories: [] });
    assert.ok(value.startsWith(`${SUBSCRIBE_DRAFT_COOKIE}=`));
    assert.match(value, /HttpOnly/);
    assert.match(value, /Path=\/subscribe/);
    assert.match(value, /SameSite=Lax/);
    assert.match(value, /Max-Age=\d+/);
    assert.ok(!/Secure/.test(value), '本地与 e2e 跑在 http 上，带 Secure 会导致 cookie 根本写不进去');
  });

  it('清除用的 Set-Cookie 把有效期归零且路径一致（否则清不掉）', () => {
    const value = clearedSubscribeDraftCookie();
    assert.match(value, new RegExp(`^${SUBSCRIBE_DRAFT_COOKIE}=;`));
    assert.match(value, /Max-Age=0/);
    assert.match(value, /Path=\/subscribe/);
  });
});
