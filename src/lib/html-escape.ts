/**
 * HTML 转义（issue #37 建立，issue #83 合并为一份）。
 *
 * **凡是插进 HTML 正文的动态值都必须过这一层**，包括 `href` 里的动态值 —— 属性里一个
 * 双引号就能跳出引号、改写整段标记，而官方原文链接来自源站、退订链接带用户 token，
 * 都不是本站能替其担保的内容。
 *
 * 为什么必须做：本站有两处手工拼 HTML 的地方 —— 邮件正文（`lib/mail.ts`）与后台
 * （`app/admin/admin-html.ts`），两处都在拼字符串而不是走框架转义。邮件那侧的后果
 * 不只是排版乱：任何人可以用**别人的邮箱**提交带 HTML 的订阅规则，收件人收到的确认信
 * 里就会渲染攻击者控制的标签与链接（钓鱼面）。
 *
 * 两处此前各有一份**逐字节相同**的实现（发行记录见 issue #80）：邮件那份有安全测试，
 * 后台那份一个都没有 —— 同一行代码，一份被守卫、一份裸奔。合并成一份之后，
 * 测试守的就是两处共用的这一份（`tests/unit/admin-html.test.mjs` /
 * `tests/unit/mail-html.test.mjs` 都打在这里）。
 *
 * `&` 必须第一个换：先换 `<` 会把 `&lt;` 里的 `&` 再换一遍，变成 `&amp;lt;`。
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
