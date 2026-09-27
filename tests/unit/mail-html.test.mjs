import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildConfirmationEmail,
  buildReminderEmail,
  buildTaskFailureAlertEmail,
} from '../../src/lib/mail.ts';
/**
 * 单元：邮件正文的 HTML 转义（issue #37）。
 *
 * ## 为什么
 *
 * 邮件正文是手工拼的 HTML 字符串。此前插进 `html` 的动态值都没转义，三个来源都不可信：
 * - **订阅关键词**：来自公开表单。任何人可以用**别人的邮箱**提交带 HTML 的规则，
 *   收件人收到的确认邮件里就会渲染攻击者控制的标签/链接（钓鱼面）；
 * - **错误摘要**：抓取失败的原始报文（可能含 `<`）；
 * - **条目标题 / 截止日期**：来自源站（标题里出现 `&` 只是时间问题，feed 那边就为
 *   `&` / `<` 专门加过用例）。
 *
 * 纯文本部分（text）**不转义** —— 用户在那里看到的就是字面内容，转义反而会让
 * 「关键词：a&b」变成「a&amp;b」。
 */

describe('issue #37：邮件 HTML 转义', () => {
  it('确认邮件：订阅关键词里的 HTML 被转义（纯文本部分保持字面）', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const mail = buildConfirmationEmail({
      email: 'victim@example.com',
      rules: { keywords: [payload, 'a&b"c'], categories: ['生态环境'] },
      confirmToken: 'confirm-token',
      unsubscribeToken: 'unsub-token',
    });

    assert.ok(!mail.html.includes('<img'), `HTML 里不应出现原始标签：${mail.html}`);
    assert.match(mail.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(mail.html, /a&amp;b&quot;c/, '& 与引号也要转义');
    // 结构标签（我们自己写的）必须还在
    assert.match(mail.html, /<p>/, '自家标签不应被转义');
    assert.match(mail.html, /<br>/);

    // 纯文本部分不转义：用户看到的是字面内容
    assert.match(mail.text, /<img src=x onerror=alert\(1\)>/);
    assert.match(mail.text, /a&b"c/);
  });

  it('提醒邮件：标题与截止日期里的 HTML 被转义', () => {
    const mail = buildReminderEmail({
      email: 'a@example.com',
      notice: {
        id: 'x'.repeat(16),
        sourceId: 'npc',
        title: '关于《A&B条例（<试行>）》公开征求意见的通知',
        agency: '司法部',
        url: 'https://example.gov.cn/a',
        publishedAt: '2026-09-01',
        deadlineAt: null,
        status: 'open',
        categoryTags: [],
        bodyText: null,
        attachments: [],
        aiSummary: null,
        summaryModel: null,
        fetchedAt: '2026-09-01T00:00:00.000Z',
        outboundClicks: 0,
        versionOf: null,
        versionSeq: null,
        agencyKeys: null,
      },
      days: 7,
      stage: 'd7',
      unsubscribeToken: 'unsub-token',
    });

    assert.ok(!mail.html.includes('<试行>'), '标题里的尖括号不应成为标签');
    assert.match(mail.html, /A&amp;B条例（&lt;试行&gt;）/);
    assert.match(mail.html, /截止日期：<strong>未标注<\/strong>/, '缺截止日期时给占位文案');
    assert.match(mail.text, /A&B条例（<试行>）/, '纯文本保持字面');
  });

  it('告警邮件：错误摘要与任务名被转义（含 <pre> 里的原始报文）', () => {
    const mail = buildTaskFailureAlertEmail({
      to: 'admin@example.com',
      jobName: 'crawl-notices',
      sourceId: 'npc',
      sourceName: '全国人大网',
      error: 'HTTP 500：<html><body>Bad Gateway</body></html>',
      now: new Date('2026-09-21T00:00:00.000Z'),
    });

    assert.ok(!mail.html.includes('<html>'), '错误报文里的标签不应原样进 HTML');
    assert.match(mail.html, /&lt;html&gt;&lt;body&gt;Bad Gateway&lt;\/body&gt;&lt;\/html&gt;/);
    assert.match(mail.html, /<pre>/, '自家 <pre> 结构保留');
    assert.match(mail.text, /HTTP 500：<html><body>Bad Gateway<\/body><\/html>/);
  });

  it('提醒邮件：href 里的动态值也转义（官方原文 URL 来自源站）', () => {
    // 同一份规矩的另一半：属性值也是动态值。一个双引号就能跳出 href，把源站数据变成
    // 邮件正文里的标记与链接 —— issue #50 之前标题与截止日期都转义了，URL 没有。
    const hostile = 'https://example.gov.cn/a"onmouseover="alert(1)';
    const mail = buildReminderEmail({
      email: 'a@example.com',
      notice: {
        id: 'x'.repeat(16),
        sourceId: 'npc',
        title: '正常标题',
        agency: '司法部',
        url: hostile,
        publishedAt: '2026-09-01',
        deadlineAt: '2026-09-08',
        status: 'open',
        categoryTags: [],
        bodyText: null,
        attachments: [],
        aiSummary: null,
        summaryModel: null,
        fetchedAt: '2026-09-01T00:00:00.000Z',
        outboundClicks: 0,
        versionOf: null,
        versionSeq: null,
        agencyKeys: null,
      },
      days: 7,
      stage: 'd7',
      unsubscribeToken: 'unsub-token',
    });

    assert.ok(
      !mail.html.includes('onmouseover="alert(1)"'),
      `href 里的引号不应逃出属性：${mail.html}`,
    );
    assert.match(mail.html, /href="https:\/\/example\.gov\.cn\/a&quot;onmouseover=&quot;alert\(1\)"/);
    assert.match(mail.text, /https:\/\/example\.gov\.cn\/a"onmouseover="alert\(1\)/, '纯文本保持字面');
  });
});

/**
 * 受众面写进确认邮件（issue #84）。
 *
 * 确认邮件是用户唯一能看到"我到底订了什么"的地方（本站没有账号、没有订阅管理后台，
 * 只有邮件底部那个带 token 的入口）。所以三件事必须同时成立：勾了要说清是收窄、
 * 「订全部 + 只看某一档」不能退化成"不限条件"、没勾就一个字都别多写。
 */
describe('issue #84：确认邮件里的受众面', () => {
  const mailOf = (rules, pendingRules) =>
    buildConfirmationEmail({
      email: 'reader@example.test',
      rules,
      pendingRules,
      confirmToken: 'confirm-token',
      unsubscribeToken: 'unsub-token',
    });

  it('勾了受众面 ⇒ 写明这是收窄条件（不能读成"再多命中一档"）', () => {
    const mail = mailOf({
      keywords: ['噪声'],
      categories: [],
      agencies: [],
      audiences: ['public'],
      scope: 'rules',
    });
    assert.match(mail.text, /关键词：噪声/);
    assert.match(mail.text, /受众面（收窄条件，只有这些才会发）：公众广域/);
    assert.match(mail.html, /受众面（收窄条件，只有这些才会发）：公众广域/);
  });

  it('scope=all + 受众面 ⇒ 不能写成"不限关键词 / 领域 / 机关"（那等于把收窄说没了）', () => {
    const mail = mailOf({ keywords: [], categories: [], agencies: [], audiences: ['public'], scope: 'all' });
    assert.ok(
      !mail.text.includes('不限关键词'),
      `订全部但勾了受众面时，这句话是假的：\n${mail.text}`,
    );
    assert.match(mail.text, /收录的全部新公示，但只发受众面属于「公众广域」的那些/);
  });

  it('没勾受众面 ⇒ 一个字都不多写（存量订阅的确认邮件与旧版逐字一致）', () => {
    const mail = mailOf({ keywords: ['噪声'], categories: [], agencies: [], audiences: [], scope: 'rules' });
    assert.ok(!mail.text.includes('受众面'), `没勾就不该出现这个词：\n${mail.text}`);
    assert.match(mail.text, /订阅范围：收录的全部新公示（不限关键词 \/ 领域 \/ 机关）|关键词：噪声/);
    const all = mailOf({ keywords: [], categories: [], agencies: [], audiences: [], scope: 'all' });
    assert.match(all.text, /订阅范围：收录的全部新公示（不限关键词 \/ 领域 \/ 机关）/);
  });
});
