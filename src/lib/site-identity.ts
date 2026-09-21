/**
 * 站点对外身份常量（爬虫 UA 里的联系地址）。
 *
 * 为什么不复用 site-url.ts 的 `SITE_URL`：UA 是给**源站运维**看的固定身份 ——
 * 他们若因流量来查「谁在抓我们」，得能顺着地址落到一个说明来意的页面上。
 * SITE_URL 是运行期站点地址（本地开发时是 localhost），跟着它走的话，开发机
 * 跑一轮抓取就会在 UA 里声明 localhost，源站运维按这个地址找不到人。所以这里
 * 是**常量**，与运行期站点地址分家。
 *
 * 只此一处：爬虫与审计 / 快照脚本原先各自硬编码同一串 UA（6 处），改一处漏
 * 一处的代价是源站收到一个指向死主机的联系地址（2026-09-21 GitHub 账号停用
 * 时就是这样：UA 里还写着已 404 的仓库地址）。
 */

/** 生产站点源（对外声明的联系地址用，与运行期 SITE_URL 无关） */
export const SITE_ORIGIN = 'https://cn101.top';

/**
 * 抓取源站时使用的 UA。
 *
 * 保持纯 ASCII：HTTP 头是 ByteString，非 ASCII 字符会直接抛错。
 * 联系地址指向本站而不是代码仓库（仓库地址随时可能不可达）。
 */
export const CRAWLER_USER_AGENT = `zhurenweng-crawler/0.1 (+${SITE_ORIGIN}; gov-notice aggregator)`;
