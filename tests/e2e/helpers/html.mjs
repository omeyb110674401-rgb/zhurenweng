/**
 * e2e 共用的 HTML 断言小工具。
 *
 * 为什么要有它：本会话里「单元格内容变成钻取链接」这件事让**四个**测试解析器先后失效
 * （issue #45 趋势格子、#47 分布桶与 notice-brief 里的副本、#48 行小计），根因都一样 ——
 * 解析器直接 `\d+` 取数字，而链接的 `href` 里也含数字（`period=b16_30`、`month=2026-08`）。
 * 于是把规矩固定在这里：
 *
 * 1. **从单元格取数字前先剥标签**（`cellNumber`）；
 * 2. robots / canonical 只在 `</head>` 之前找（页面正文里可能出现同名文本）；
 * 3. React SSR 在「文本 + 表达式」混排处插的 `<!-- -->` 先剥掉（`stripSsrComments`）。
 *
 * 只放纯字符串工具，不引入任何依赖（ADR-0001：e2e 零外部依赖）。
 */

/**
 * 列表页 → 条目块数组（每条一个 `<li …>…</li>` 片段）。
 *
 * 为什么收成一处：**12 个 e2e 文件各自写了一遍**「按 `<li class="notice-item"` 切块」
 * （`split(...).slice(1)` 与 `matchAll(...)` 两种写法）。列表项一旦改标记，要同时改
 * 12 处，漏一处就是「解析不到 → 断言报出看不懂的错」。字段提取仍留在各文件里
 * （各测各的字段），这里只固定**什么算一条**。
 *
 * 匹配 `data-testid="notice-item"` 而不是 class：testid 是本仓库 e2e 的稳定契约
 * （`notice-item.tsx` 上两个属性都有），class 是样式细节，改版式时容易跟着动。
 */
export function noticeItems(html) {
  return [...String(html).matchAll(/<li[^>]*data-testid="notice-item"[^>]*>[\s\S]*?<\/li>/g)].map(
    (match) => match[0],
  );
}

/** React SSR 在「文本 + 表达式」混排处插入 `<!-- -->` 注释，文本断言前剥掉。 */
export function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 取 `</head>` 之前的片段（robots / canonical / title 都只该在这里找）。 */
export function headOf(html) {
  const end = html.indexOf('</head>');
  return end < 0 ? html : html.slice(0, end);
}

/**
 * 从一段 HTML（通常是一个 `<td>` / `<span>` 的内容）里取数字。
 *
 * **先剥标签再取第一个整数** —— 单元格内容可能是钻取链接，`href` 里的
 * `month=2026-08` / `period=b16_30` 会被裸 `\d+` 抢先命中。取不到数字时抛错，
 * 不返回 0（静默的 0 会让「条数与表格一致」这类不变式变成假绿）。
 */
export function cellNumber(fragment) {
  const text = String(fragment).replace(/<[^>]*>/g, '');
  const match = /(\d+)/.exec(text);
  if (match === null) {
    throw new Error(`单元格内找不到数字：${JSON.stringify(String(fragment).slice(0, 120))}`);
  }
  return Number(match[1]);
}

/** 页面 head 里的 `<meta name="robots">` 内容；没有则返回 null。 */
export function robotsMeta(html) {
  return /<meta name="robots" content="([^"]*)"/.exec(headOf(html))?.[1] ?? null;
}

/** 页面 head 里的 canonical 绝对地址（`&amp;` 已还原）；没有则返回 null。 */
export function canonicalHref(html) {
  return (
    /<link rel="canonical" href="([^"]*)"/.exec(headOf(html))?.[1]?.replaceAll('&amp;', '&') ?? null
  );
}

/** 页面 head 里的 `<meta name="<name>">` 内容；没有则返回 null。 */
export function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<meta name="${escaped}" content="([^"]*)"`).exec(headOf(html))?.[1] ?? null;
}

/** 从 `<a …>` 标签文本里取 href（React 渲染的属性顺序不固定，故单独取）。 */
export function hrefOf(anchorHtml) {
  return /href="([^"]*)"/.exec(anchorHtml)?.[1]?.replaceAll('&amp;', '&') ?? null;
}
