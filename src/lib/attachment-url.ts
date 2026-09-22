/**
 * 附件的取回地址候选（issue #57）。
 *
 * 为什么需要：miit 的附件写成 `https://jyhwzhq.miit.gov.cn/cms_files/...`，那台子域挂在
 * CDN 后面、对我们机房出口**整台主机**回 403（连 `robots.txt` 都回 403 页），而同一条
 * 路径搬到 `www.miit.gov.cn` 上回 200 —— 2026-09-22 把库里 14 个被拒附件逐个换域实测，
 * 14/14 取回且文件头与扩展名相符（pdf → `%PDF`、doc/wps → OLE2）。政务 CMS 常把静态
 * 目录同时挂在主域上，所以「换到引用它的那个 origin 再取一次」是有依据的一手。
 *
 * 三条限制，越窄越好：
 * - 这里只**列出**候选，动不动用由调用方决定：附件任务是在直连已经取不到之后才试第二条，
 *   正常源站的请求量不变。
 * - 候选地址固定由**这条公示详情页自己的 origin**（协议 + 主机 + 端口，也就是我们每轮
 *   都在抓页面的那个地址）拼出来，于是这一手只是把一个观测为取不到的地址换成一个已知
 *   可用的地址，不会引入新的出网目标。
 * - 要求两主机名共享 ≥3 段后缀（即到 `miit.gov.cn` 这一层）。宁可漏掉一些换域能救的文件，
 *   也不把路径送到一个只是碰巧同注册域别的站点上：`.com.cn` / `.gov.cn` 这类公共后缀下
 *   「共享 2 段」会把两个互不相干的站点判成同站。
 */

/** 两个主机名共享的点分隔后缀有多少段（`a.miit.gov.cn` 与 `www.miit.gov.cn` → 3）。 */
function commonSuffixLabels(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  let shared = 0;
  while (
    shared < left.length
    && shared < right.length
    && left[left.length - 1 - shared] === right[right.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared;
}

/**
 * @param attachmentUrl 详情页里写着的附件地址（也是这一行存库的地址，不变）
 * @param noticeUrl 这条公示的详情页地址
 * @returns 按顺序尝试的地址；同站取不到时才多出第二条
 */
export function attachmentUrlCandidates(attachmentUrl: string, noticeUrl: string): string[] {
  let file: URL;
  let page: URL;
  try {
    file = new URL(attachmentUrl);
    page = new URL(noticeUrl);
  } catch {
    return [attachmentUrl];
  }
  // 比 origin 而非 hostname：同主机不同端口也算两处（e2e 用这个形状跑通「先拒后取」，
  // 生产上对应 http/https 或非标端口混写的那类源站）
  if (file.origin === page.origin) return [attachmentUrl];
  if (commonSuffixLabels(file.hostname, page.hostname) < 3) return [attachmentUrl];
  const rewritten = new URL(`${file.pathname}${file.search}`, page);
  return rewritten.toString() === attachmentUrl
    ? [attachmentUrl]
    : [attachmentUrl, rewritten.toString()];
}
