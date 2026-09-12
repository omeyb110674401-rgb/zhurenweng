import type { SourceRecord } from '@/db/types';
import type { ReviewQueueItem } from '@/db/repo/summaries';

/**
 * 管理后台的 HTML 渲染（issue #12）。
 *
 * /admin 是站长内部工具，用最简方式实现：路由处理器直接返回自包含 HTML
 * （内联样式、零客户端 JS、零新依赖），换取对状态码的完全控制 ——
 * 未授权返回真实 401，表单提交后 303 重定向回本页。
 * 所有插值统一经 escapeHtml 转义（错误信息 / 源名等可能含任意字符）。
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 空值展示占位 */
const DASH = '—';

const STYLE = `
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #1c2430; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  .muted { color: #5b6673; font-size: 13px; }
  header.admin-bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-bottom: 2px solid #1c4ed8; padding-bottom: 12px; }
  .flash { margin: 16px 0; padding: 10px 14px; border-radius: 6px; font-size: 14px; }
  .flash-ok { background: #e6f6ea; border: 1px solid #46a46c; }
  .flash-error { background: #fdecec; border: 1px solid #d64545; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 14px; }
  th, td { border: 1px solid #d8dee6; padding: 8px 10px; text-align: left; vertical-align: top; }
  thead th { background: #eef2f7; }
  td .mono { font-size: 12px; color: #5b6673; }
  section { margin-bottom: 8px; }
  form.inline { display: inline; }
  form.stack { background: #fff; border: 1px solid #d8dee6; border-radius: 6px; padding: 14px 16px; display: grid; gap: 10px; max-width: 640px; }
  label { display: grid; gap: 2px; font-size: 13px; }
  input, textarea { font: inherit; padding: 6px 8px; border: 1px solid #c3ccd8; border-radius: 4px; }
  button { font: inherit; padding: 6px 14px; border-radius: 4px; border: 1px solid #1c4ed8; background: #1c4ed8; color: #fff; cursor: pointer; }
  button.ghost { background: #fff; color: #1c4ed8; }
  ul.plain { list-style: none; padding: 0; display: grid; gap: 16px; }
  li.review-item { background: #fff; border: 1px solid #d8dee6; border-radius: 6px; padding: 14px 16px; }
  .review-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  fieldset { border: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .login-box { max-width: 420px; margin: 64px auto; background: #fff; border: 1px solid #d8dee6; border-radius: 8px; padding: 24px; }
  .login-error { color: #c02626; }
`;

export function adminPageDocument(bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>管理后台 —— 主人翁</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body class="admin-page">',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('');
}

/** 表单操作后的提示横幅（经 303 重定向的查询参数回传）。 */
export type AdminFlashKey =
  | 'review_reset'
  | 'review_saved'
  | 'notice_inserted'
  | 'notice_updated'
  | 'source_updated';

export type AdminErrorKey =
  | 'missing_fields'
  | 'invalid_url'
  | 'invalid_date'
  | 'notice_not_found'
  | 'not_in_review'
  | 'source_not_found';

const FLASH_TEXT: Record<AdminFlashKey, string> = {
  review_reset: '已重置为待生成（pending），摘要任务下一轮将自动重新生成摘要。',
  review_saved: '已保存人工摘要，状态置为 done。',
  notice_inserted: '补录条目已入库，并已同步检索索引；摘要任务下一轮自动生成摘要。',
  notice_updated: '该原文 URL 已存在，条目内容已按录入更新（幂等去重）。',
  source_updated: '源启用状态已更新。',
};

const ERROR_TEXT: Record<AdminErrorKey, string> = {
  missing_fields: '标题、发布机关与原文 URL 为必填项，请补全后重试。',
  invalid_url: '原文 URL 必须是 http(s) 绝对地址。',
  invalid_date: '发布 / 截止日期格式应为 YYYY-MM-DD。',
  notice_not_found: '条目不存在。',
  not_in_review: '该条目不在待复核状态，无需重置。',
  source_not_found: '源不存在或尚未登记。',
};

export function renderFlash(ok: string | null, error: string | null): string {
  if (ok && ok in FLASH_TEXT) {
    return `<div class="flash flash-ok" data-testid="admin-flash" data-flash="${escapeHtml(ok)}">${escapeHtml(FLASH_TEXT[ok as AdminFlashKey])}</div>`;
  }
  if (error && error in ERROR_TEXT) {
    return `<div class="flash flash-error" data-testid="admin-flash" data-flash="${escapeHtml(error)}">${escapeHtml(ERROR_TEXT[error as AdminErrorKey])}</div>`;
  }
  return '';
}

/** 未授权引导页（401）：配置了 ADMIN_TOKEN 时展示登录表单，否则给出配置指引。 */
export function renderUnauthorizedBody(options: { tokenConfigured: boolean; mismatch: boolean }): string {
  const inner = options.tokenConfigured
    ? [
        '<p class="muted">输入管理令牌进入控制台。令牌由环境变量 ADMIN_TOKEN 配置，登录状态保持 7 天。</p>',
        ...(options.mismatch
          ? ['<p class="login-error" data-testid="admin-login-error">令牌不匹配或已失效，请重试。</p>']
          : []),
        '<form method="post" action="/admin/login" data-testid="admin-login-form">',
        '<label>管理令牌<input type="password" name="token" required autofocus></label>',
        '<button type="submit" data-testid="admin-login-submit">登录</button>',
        '</form>',
      ].join('')
    : [
        '<p class="muted">尚未配置管理令牌：请设置环境变量 <code>ADMIN_TOKEN</code> 后重启服务，',
        '再用它登录管理后台。</p>',
      ];
  return adminPageDocument(
    `<main><div class="login-box"><h1>管理后台</h1>${inner}</div></main>`,
  );
}

function formatTimestamp(value: string | null): string {
  return value ? `<span class="mono">${escapeHtml(value)}</span>` : DASH;
}

function sourceToggleForm(source: SourceRecord): string {
  const action = source.enabled ? 'disable' : 'enable';
  const label = source.enabled ? '停用' : '启用';
  return [
    `<form method="post" action="/admin/sources" class="inline">`,
    `<input type="hidden" name="id" value="${escapeHtml(source.id)}">`,
    `<input type="hidden" name="action" value="${action}">`,
    `<button type="submit" class="ghost" data-testid="source-toggle-button">${label}</button>`,
    '</form>',
  ].join('');
}

/** 源健康看板：每源最近成功抓取时间、最近错误信息与时间、启用状态。 */
export function renderSourceBoard(sources: SourceRecord[]): string {
  const rows = sources
    .map(
      (source) => [
        `<tr data-testid="source-health-row" data-source-id="${escapeHtml(source.id)}">`,
        `<th scope="row">${escapeHtml(source.name)}<br><span class="mono">${escapeHtml(source.id)}</span></th>`,
        `<td data-field="status">${source.healthy ? '健康' : '异常'}</td>`,
        `<td data-field="enabled">${source.enabled ? '启用' : '停用'}</td>`,
        `<td data-field="last-success">${formatTimestamp(source.lastSuccessAt)}</td>`,
        `<td data-field="last-error">${source.lastErrorMessage ? escapeHtml(source.lastErrorMessage) : DASH}</td>`,
        `<td data-field="last-error-at">${formatTimestamp(source.lastErrorAt)}</td>`,
        `<td>${sourceToggleForm(source)}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');
  return [
    '<section aria-labelledby="board-title">',
    '<h2 id="board-title">源健康看板</h2>',
    '<p class="muted">每个抓取源的最近成功时间、最近错误与启用状态；停用的源会被抓取任务跳过。</p>',
    sources.length === 0
      ? '<div class="muted" data-testid="source-board-empty">尚无源登记记录，抓取任务运行一次后出现。</div>'
      : [
          '<table data-testid="source-health-board">',
          '<thead><tr><th scope="col">源</th><th scope="col">健康</th><th scope="col">启用</th>',
          '<th scope="col">最近成功抓取</th><th scope="col">最近错误信息</th><th scope="col">最近错误时间</th><th scope="col">操作</th></tr></thead>',
          `<tbody>${rows}</tbody>`,
          '</table>',
        ].join(''),
    '</section>',
  ].join('');
}

/** 复核队列单条：重置重试 + 直接编辑保存两种处置。 */
function reviewItem(item: ReviewQueueItem): string {
  return [
    `<li class="review-item" data-testid="review-queue-item" data-notice-id="${escapeHtml(item.id)}">`,
    `<p><a data-testid="review-item-link" href="/notices/${escapeHtml(item.id)}">${escapeHtml(item.title)}</a></p>`,
    `<p class="muted">发布机关：${escapeHtml(item.agency)} · 源：${escapeHtml(item.sourceId)} · 状态：${escapeHtml(item.status)} · 截止：${item.deadlineAt ? escapeHtml(item.deadlineAt) : DASH}</p>`,
    `<p class="muted">原文：<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></p>`,
    `<form method="post" action="/admin/review" class="inline">`,
    `<input type="hidden" name="noticeId" value="${escapeHtml(item.id)}">`,
    `<input type="hidden" name="action" value="reset">`,
    `<button type="submit" class="ghost" data-testid="review-reset-button">重置并重试摘要</button>`,
    '</form>',
    `<form method="post" action="/admin/review" class="stack">`,
    `<input type="hidden" name="noticeId" value="${escapeHtml(item.id)}">`,
    `<input type="hidden" name="action" value="save">`,
    '<p class="muted">或直接人工修订五段式摘要，保存后详情页立即展示（不再自动重试）：</p>',
    '<div class="review-grid">',
    '<label>这是什么（必填）<input name="what" required></label>',
    '<label>影响谁（必填）<input name="who" required></label>',
    '<label>截止日期（可空）<input type="date" name="deadline"></label>',
    '<label>如何提意见（必填）<input name="howToComment" required></label>',
    '</div>',
    '<label>关键条款（每行一条）<textarea name="keyPoints" rows="3" placeholder="条款一&#10;条款二"></textarea></label>',
    `<button type="submit" data-testid="review-save-button">保存为已复核摘要（done）</button>`,
    '</form>',
    '</li>',
  ].join('');
}

/** 摘要人工复核队列（summary_status = failed_review）。 */
export function renderReviewQueue(items: ReviewQueueItem[]): string {
  return [
    '<section aria-labelledby="review-title">',
    '<h2 id="review-title">摘要人工复核队列</h2>',
    '<p class="muted">AI 摘要重试耗尽的条目汇总在此（summary_status=failed_review），两种处置：重置后由摘要任务自动重试；或人工修订后保存为完成。</p>',
    items.length === 0
      ? '<div class="muted" data-testid="review-queue-empty">当前没有待复核的摘要。</div>'
      : `<ul class="plain" data-testid="review-queue">${items.map(reviewItem).join('')}</ul>`,
    '</section>',
  ].join('');
}

/** 手动补录：与爬虫相同的入库 → 摘要 → 检索索引管线。 */
export function renderManualEntryForm(): string {
  return [
    '<section aria-labelledby="manual-title">',
    '<h2 id="manual-title">手动补录条目</h2>',
    '<p class="muted">结构化录入后走与爬虫相同的入库、摘要与检索索引管线：以原文 URL 为唯一键幂等去重，摘要任务下一轮自动生成 AI 摘要。</p>',
    '<form method="post" action="/admin/notices" class="stack" data-testid="manual-entry-form">',
    '<label>标题（必填）<input name="title" required></label>',
    '<div class="review-grid">',
    '<label>发布机关（必填）<input name="agency" required></label>',
    '<label>原文 URL（必填，唯一键）<input name="url" type="url" required placeholder="https://www.npc.gov.cn/…"></label>',
    '<label>发布日期（可空）<input type="date" name="publishedAt"></label>',
    '<label>截止日期（可空）<input type="date" name="deadlineAt"></label>',
    '</div>',
    '<label>正文纯文本（可空，AI 摘要的输入）<textarea name="bodyText" rows="6"></textarea></label>',
    '<button type="submit" data-testid="manual-entry-submit">入库并进入摘要管线</button>',
    '</form>',
    '</section>',
  ].join('');
}

/** 已授权的管理后台主页。 */
export function renderDashboardBody(options: {
  flashOk: string | null;
  flashError: string | null;
  sources: SourceRecord[];
  reviewItems: ReviewQueueItem[];
}): string {
  return adminPageDocument(
    [
      '<main data-testid="admin-dashboard">',
      '<header class="admin-bar">',
      '<div><h1>管理后台</h1><p class="muted">主人翁 · 源健康 / 摘要复核 / 手动补录</p></div>',
      '<div>',
      '<a href="/">← 返回站点首页</a> ',
      '<form method="post" action="/admin/logout" class="inline"><button type="submit" class="ghost" data-testid="admin-logout-button">退出登录</button></form>',
      '</div>',
      '</header>',
      renderFlash(options.flashOk, options.flashError),
      renderSourceBoard(options.sources),
      renderReviewQueue(options.reviewItems),
      renderManualEntryForm(),
      '</main>',
    ].join(''),
  );
}
