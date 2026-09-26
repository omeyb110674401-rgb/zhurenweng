import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  escapeHtml,
  renderManualEntryForm,
  renderReviewQueue,
  renderSourceBoard,
} from '../../src/app/admin/admin-html.ts';

/**
 * 单元（issue #83）：后台 HTML 拼接的转义（**此前零测试**）。
 *
 * 为什么值得补：`admin-html.ts` 手拼 HTML（issue #12 的取舍：换 401/303 状态码的完全控制），
 * 而它插值的东西里有**任意来源的字符串** —— 抓取失败的错误信息（源站回什么就写什么）、
 * 源名、后台人工录入的标题与机关。这里没有转义就是一发 XSS，且后台是**带令牌的登录态**。
 *
 * 它与 `src/lib/mail.ts` 里那份 `escapeHtml` 曾经是逐字节相同的两份：
 * 邮件那份有安全测试，后台这份一个都没有（同一行代码，一份被守卫、一份裸奔）。
 * issue #83 把两份并成 `lib/html-escape.ts` 一份，并把测试补在这里。
 */

/** 一条"什么脏字符都带"的输入。 */
const NASTY = `<img src=x onerror="alert('x')">&'"`;

function sourceRow(overrides = {}) {
  return {
    id: 'mee',
    name: '生态环境部办公厅',
    adapterType: 'html',
    healthy: true,
    consecutiveFailures: 0,
    lastSuccessAt: '2026-09-26T00:00:00.000Z',
    lastErrorMessage: null,
    lastErrorAt: null,
    enabled: true,
    ...overrides,
  };
}

describe('issue #83：后台 HTML 转义', () => {
  it('五个字符全部转义（& < > " \'）', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
    // & 必须第一个换：先换 < 会把 &lt; 里的 & 再换一遍，变成 &amp;lt;
    assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
    assert.equal(
      escapeHtml(NASTY),
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;&#39;&quot;',
    );
  });

  it('源健康看板：源名与错误信息里的标签不会变成真标签', () => {
    const html = renderSourceBoard([
      sourceRow({ name: NASTY, lastErrorMessage: NASTY, consecutiveFailures: 3 }),
    ]);
    assert.ok(!html.includes('<img'), '源名里的 <img 不许原样落到页面上');
    assert.ok(!html.includes('onerror="alert'), '内联事件处理器不许原样出现');
    assert.ok(html.includes('&lt;img'), '转义后的形态应当在（证明值确实渲染了，不是被整条丢掉）');
    // 连续失败列（issue #58）也要在：降噪的补偿就是"看得见已经坏了几轮"
    assert.match(html, /连续 3 轮/);
  });

  it('复核队列：受众面与依据同屏，且值一律转义（issue #83 新增的那一行）', () => {
    const html = renderReviewQueue([
      {
        id: 'abc12345',
        title: NASTY,
        agency: NASTY,
        url: 'https://example.gov.cn/x',
        sourceId: 'mee',
        status: 'open',
        deadlineAt: '2026-10-01',
        genre: 'amendment',
        genreBasis: '附件正文含对照措辞「修改为」',
        audience: 'sector',
        audienceBasis: NASTY,
      },
    ]);
    assert.match(html, /受众面：行业专业/, '受众面要有中文名（不是把 public/sector 直接印出来）');
    assert.ok(html.includes('依据：&lt;img'), '判定依据要转义后渲染');
    assert.ok(html.includes('体裁：修正案'), '体裁那一行照旧');
    assert.ok(!html.includes('<img'), '整块 HTML 里不许出现未转义的标签');
  });

  it('未知取值原样显示而不是渲染成 undefined', () => {
    const html = renderReviewQueue([
      {
        id: 'abc12345',
        title: 't',
        agency: 'a',
        url: 'https://example.gov.cn/x',
        sourceId: 'mee',
        status: 'open',
        deadlineAt: null,
        genre: null,
        genreBasis: null,
        audience: null,
        audienceBasis: null,
      },
    ]);
    assert.match(html, /受众面：—/, '没有判定值时给占位符，不渲染 undefined');
    assert.ok(!html.includes('undefined'));
  });

  it('手动补录表单的结构（后台唯一的写入口）', () => {
    const html = renderManualEntryForm();
    assert.match(html, /action="\/admin\/notices"/);
    assert.match(html, /method="post"/);
    for (const field of ['title', 'agency', 'url', 'publishedAt', 'deadlineAt', 'bodyText']) {
      assert.match(html, new RegExp(`name="${field}"`), `补录表单应含 ${field}`);
    }
  });
});
