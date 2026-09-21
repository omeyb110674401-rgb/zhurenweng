/**
 * 抓取出网守卫（issue #52）：抓取器跟随的是**第三方页面给出的地址**，因此每一跳
 * 都必须先回答「这个目标该不该由我们的 worker 去请求」。
 *
 * 为什么需要它：详情 URL 由源站列表 HTML 解析而来（`extract.ts` 的 resolveUrl 只看
 * 协议），列表页被挂马 / 改版返回 `http://169.254.169.254/latest/meta-data/` 或
 * 阿里云元数据 `100.100.100.200` 时，worker 会主动去请求 —— 拿到的东西还能以纯文本
 * 入库并公开渲染，等于一条数据外带通道。重定向同理：源站上一个开放重定向就能把请求
 * 引到内网，所以**每一跳**都要过这里，而不是只看第一个 URL。
 *
 * 为什么不做「同源白名单」：交通运输部「意见征集」栏目的条目链接**跨域混排**
 * （本部 mot.gov.cn / 民航局 caac.gov.cn / 国家铁路局 nra.gov.cn，见 mot.ts 文件头）。
 * 硬性同源会让这些条目静默退化为列表层数据 —— 正是 issue #30 / #51 反复对抗的
 * 「静默烂掉」失败模式。所以口径是「**必须是公网 http(s) 目标**」，不限制具体站点。
 *
 * 已知残留（有意不覆盖）：只做**字面量**判定，不做 DNS 解析 —— 一个公网域名解析到
 * 私网 IP（DNS rebinding / 内网域名）仍能穿透。要覆盖得引入 node:dns 解析 + 缓存，
 * 且每个新主机多一次解析延迟；对「十个固定政府站点」这个抓取面，收益不抵复杂度。
 * 见 docs/pending-issues/FOLLOWUPS.md。
 */

/** 判定结果：`ok=false` 时 reason 会进 worker 日志（人要能看懂为什么没抓）。 */
export type CrawlUrlVerdict = { ok: true } | { ok: false; reason: string };

/** IPv4 禁止段（[网络地址, 前缀长度]）：私网 / 环回 / 链路本地 / CGNAT / 保留段。 */
const BLOCKED_IPV4_RANGES: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // 0.0.0.0/8       本网络
  [0x0a000000, 8], // 10.0.0.0/8      私网
  [0x64400000, 10], // 100.64.0.0/10   运营商级 NAT（含阿里云元数据 100.100.100.200）
  [0x7f000000, 8], // 127.0.0.0/8     环回
  [0xa9fe0000, 16], // 169.254.0.0/16  链路本地（含 169.254.169.254 云元数据）
  [0xac100000, 12], // 172.16.0.0/12   私网
  [0xc0000000, 24], // 192.0.0.0/24    IETF 协议分配
  [0xc0000200, 24], // 192.0.2.0/24    TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24  6to4 中继
  [0xc0a80000, 16], // 192.168.0.0/16  私网
  [0xc6120000, 15], // 198.18.0.0/15   基准测试
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24  TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4     组播
  [0xf0000000, 4], // 240.0.0.0/4     保留（含 255.255.255.255）
];

/** 主机名后缀禁止表：内部解析域。带点的普通域名不受影响。 */
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'] as const;

/** 点分四段 → 32 位无符号整数；不是合法 IPv4 字面量时返回 null。 */
function ipv4Value(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  // >>> 的移位量按 32 取模，prefix=0 会退化成不移位 —— 上面已单独处理
  return value >>> (32 - prefix) === base >>> (32 - prefix);
}

/**
 * IPv6 字面量 → 8 组 16 位整数；不合法返回 null。
 * 支持 `::` 压缩与内嵌 IPv4（`::ffff:1.2.3.4`）。
 */
function ipv6Groups(host: string): number[] | null {
  const text = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!text.includes(':')) return null;
  // 内嵌 IPv4 先换成两组十六进制，避免 '::ffff:1.2.3.4' 被当成非法段
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  let normalized = text;
  if (tail.includes('.')) {
    const embedded = ipv4Value(tail);
    if (embedded === null) return null;
    const high = (embedded >>> 16).toString(16);
    const low = (embedded & 0xffff).toString(16);
    normalized = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const [head, ...rest] = normalized.split('::');
  if (rest.length > 1) return null; // 只允许一处 ::
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = rest.length === 1 ? (rest[0] === '' ? [] : rest[0].split(':')) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (rest.length === 0 && missing !== 0) return null;
  if (rest.length === 1 && missing < 1) return null;

  const groups = [
    ...headGroups,
    ...Array.from({ length: rest.length === 1 ? missing : 0 }, () => '0'),
    ...tailGroups,
  ];
  if (groups.length !== 8) return null;
  const values: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    values.push(Number.parseInt(group, 16));
  }
  return values;
}

/** IPv6 是否落在私网 / 环回 / 链路本地 / 组播 / 未指定段（含内嵌 IPv4 的复核）。 */
function isBlockedIpv6(host: string): boolean {
  const groups = ipv6Groups(host);
  if (groups === null) return false; // 不是 IPv6 字面量：交给主机名规则
  const [first] = groups as [number];

  // ::ffff:x.x.x.x（IPv4 映射）与 ::x.x.x.x（IPv4 兼容）：复核内嵌的 IPv4 ——
  // `::ffff:192.168.1.1` 必须按 192.168.1.1 判定，否则是一条直通内网的旁路
  const isMapped = groups.slice(0, 5).every((value) => value === 0) && groups[5] === 0xffff;
  const isCompatible = groups.slice(0, 6).every((value) => value === 0);
  if (isMapped || isCompatible) {
    const embedded = (groups[6] ?? 0) * 65536 + (groups[7] ?? 0);
    return BLOCKED_IPV4_RANGES.some(([base, prefix]) => inIpv4Range(embedded, base, prefix));
  }
  if (groups.every((value) => value === 0)) return true; // :: 未指定地址
  if (groups.slice(0, 7).every((value) => value === 0) && groups[7] === 1) return true; // ::1 环回
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 组播
  return false;
}

/** 主机名是否指向内网 / 本机（字面量判定，不做 DNS）。 */
function isBlockedHost(hostname: string): boolean {
  // 末尾的点是合法 FQDN 写法（`10.0.0.1.`），去掉后再判定，否则会绕过 IP 字面量识别
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (host.length === 0) return true;
  if (host === 'localhost') return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const ipv4 = ipv4Value(host);
  if (ipv4 !== null) {
    return BLOCKED_IPV4_RANGES.some(([base, prefix]) => inIpv4Range(ipv4, base, prefix));
  }
  // IPv6 字面量只做段判定：它本来就没有点，不能落到下面的「单标签主机名」规则上
  if (ipv6Groups(host) !== null) return isBlockedIpv6(host);

  // 单标签主机名（`intranet`、`metadata`）在容器 / 内网里通常由搜索域解析到内部地址
  return !host.includes('.');
}

/**
 * 抓取器是否可以请求这个地址。
 *
 * @param raw 待判定的绝对地址
 * @param allowedOrigins 显式放行的 origin 列表（E2E 的 fixture 源站跑在
 *   `http://127.0.0.1:<port>` 上，属环回地址 —— 由调用方按 SOURCES_FIXTURE_BASE 传入）
 */
export function isAllowedCrawlUrl(raw: string, allowedOrigins: readonly string[] = []): CrawlUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: '地址无法解析' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `协议不是 http(s)：${url.protocol}` };
  }
  if (allowedOrigins.includes(url.origin)) return { ok: true };
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: `目标指向内网 / 本机地址：${url.hostname}` };
  }
  return { ok: true };
}
