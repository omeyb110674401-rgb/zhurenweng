/**
 * 结构化速读（issue #26）：**不依赖任何大模型**的确定性抽取。
 *
 * 为什么需要它：AI 摘要要配密钥、要花钱、要过备案，任何一项没就绪，详情页
 * 的「读懂 / 行动」两个支柱就整块消失（此前退化成一句「暂未启用」）。但征求意见
 * 公告里最有行动价值的信息——**意见怎么提交**（邮箱、传真、通信地址、在线入口）
 * ——是原文用固定句式写死的，正则就能可靠取出来，且比模型改写更可信：它是原文
 * 的字符串，不是对原文的解释。
 *
 * 因此本模块的定位是「AI 摘要的**降级路径**，而不是替代品」：
 * - 大模型端口可用 → 仍走五段式 AI 摘要（见 summary-view.tsx）；
 * - 不可用 → 渲染本模块的速读卡，把原文里的提交方式、文件名、首段摆出来。
 *
 * 抽取口径的三条自律（对应「不夸大」的合规姿态）：
 * 1. 只搬原文里**逐字存在**的内容，不做归纳、改写、推断（模型才干那个）；
 * 2. 每条渠道都带原文上下文片段，读者可据此核对，也可点进官方原文复核；
 * 3. 取不到就返回空数组，页面不渲染该块——不编一条「通常可通过邮件提出」凑数。
 *
 * 分层：src/lib 不反向依赖 src/sources（适配器层），故本文件自带 collapse()。
 */

/** 渠道类型：在线入口 / 电子邮箱 / 通信地址 / 电话 / 传真 */
export type NoticeChannelKind = 'online' | 'email' | 'address' | 'phone' | 'fax';

/**
 * 渠道类型的中文标签（详情页渲染用；顺序即展示顺序）。
 *
 * `online` 刻意叫「在线渠道」而不是「在线提交」：多数部委的原文确实写着「登录…
 * 网站…提出意见」，但生态环境部写的是「可登录我部网站…"意见征集"栏目**检索查阅**」
 * ——那只是查阅草案的入口，标成「在线提交」就夸大了原文。中性标签 + 原文上下文
 * 片段一起呈现，读者自己判断；本站不替原文加码。
 */
export const CHANNEL_LABELS: Record<NoticeChannelKind, string> = {
  online: '在线渠道',
  email: '电子邮箱',
  address: '通信地址',
  phone: '联系电话',
  fax: '传真',
};

/** 一条原文注明的提交渠道 */
export interface NoticeChannel {
  kind: NoticeChannelKind;
  /** 展示值：邮箱地址 / 网址 / 地址文本 / 电话号码 */
  value: string;
  /** 可点击链接（mailto: / tel: / http(s):），无则为 null */
  href: string | null;
  /** 原文上下文片段（截断），用于核对；取不到为 null */
  context: string | null;
}

/** 结构化速读结果 */
export interface NoticeBrief {
  /** 标题里《…》括起来的文件名称（可多个，如「征求意见稿」+「起草说明」） */
  documentNames: string[];
  /** 文件性质标签（征求意见稿 / 草案 / 标准报批 / 公示 / 通知 / 反馈情况） */
  documentKind: string | null;
  /** 原文注明的提交渠道（按 kind 优先级 + 出现顺序） */
  channels: NoticeChannel[];
  /** 正文首段（原文逐字摘录，用于「一句话速读」） */
  leadParagraph: string | null;
  /** 原文分条要点（一、二、… / 1. 2. 的逐字摘录，不足两条时为空数组） */
  keyItems: string[];
}

/** 渠道块与首段的最大长度，防止个别畸形正文把整段塞进卡片 */
const MAX_CHANNELS = 8;
const MAX_CONTEXT_LENGTH = 120;
const MAX_LEAD_LENGTH = 200;
const MIN_LEAD_LENGTH = 20;

/** 折叠空白：正文以换行分块，块内可能还有全角空格。 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 按中文句读 + 换行切句（保留句末标点），用于给渠道提供上下文。 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；\n])/)
    .map(collapse)
    .filter((sentence) => sentence.length > 0);
}

/** 截断到指定长度（超出加省略号），并折叠空白。 */
function truncate(text: string, max: number): string {
  const collapsed = collapse(text);
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/** 取包含指定片段的句子作为上下文（找不到则返回 null）。 */
function contextOf(bodyText: string, needle: string): string | null {
  const index = bodyText.indexOf(needle);
  if (index < 0) return null;
  for (const sentence of sentences(bodyText)) {
    if (sentence.includes(needle)) return truncate(sentence, MAX_CONTEXT_LENGTH);
  }
  return truncate(bodyText.slice(Math.max(0, index - 40), index + needle.length + 40), MAX_CONTEXT_LENGTH);
}

// ---------------------------------------------------------------------------
// 抽取规则
// ---------------------------------------------------------------------------

/**
 * 邮箱：形状合法的才算，避免把正文里的 `xxx@` 残片当成渠道。
 * 末段（TLD）强制 ≥2 个字母，可过滤 `a@b.1` 这类噪声。
 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;

/** 单个号码：固话（区号-号码，允许 - 空格 分隔）或手机号 */
const PHONE_NUMBER = '(?:0\\d{2,3}[-－\\s]?\\d{7,8}(?:[-－转]\\d{1,6})?|1[3-9]\\d{9})';
/** 多个号码以顿号/逗号/「和」连接，如「010-64102958，010-68205261」 */
const PHONE_LIST = `(${PHONE_NUMBER}(?:\\s*[，,、；;和及]\\s*${PHONE_NUMBER})*)`;
/** 「联系电话及传真」里的号码归传真，故电话标签用否定前瞻避开该写法 */
const PHONE_LABEL = new RegExp(
  `(?:联系电话|咨询电话|联系方式|电话)(?!及传真)\\s*[:：]?\\s*${PHONE_LIST}`,
  'g',
);
const FAX_LABEL = new RegExp(`(?:传真号码|传真)(?:电话)?\\s*[:：]?\\s*${PHONE_LIST}`, 'g');

/**
 * 地址尾部的「分号 + 邮编」：句读会切断捕获，但邮编是地址的一部分。
 *
 * 实测（2026-09-20 生产库 170 条）：28 条的正文写作「…C座18层**；邮编：100013**」，
 * 分号被当作句读边界后邮编就丢了 —— 邮寄意见时邮编恰恰是必须的。故在捕获里
 * 显式允许这一段跟上来（括号形式「（邮编：100088）」本来就在捕获内，不受影响）。
 */
const ADDRESS_ZIP_TAIL = '[；;，,]\\s*邮\\s*政?\\s*编\\s*码?\\s*[:：]?\\s*\\d{6}';

/**
 * 地址（标签式）：从「通信地址：」这类标签后取到句读/换行为止。
 * 标签按长度降序排列，保证「通信地址」不被「地址」抢先匹配成短的一截。
 * 单独用「地址」时会误吞「网址」（网址不含「地址」二字，但「地址」会匹配
 * 「…地址…」这类普通词），故要求冒号紧跟在标签后。
 */
const ADDRESS_LABEL = new RegExp(
  `(?:通信地址|通讯地址|邮寄地址|联系地址|收件地址|地址)\\s*[:：]\\s*([^\\n。；;]{6,80}(?:${ADDRESS_ZIP_TAIL})?)`,
  'g',
);

/**
 * 地址（动词式）：部委公告里更常见的写法是「公众可通过以下途径提出意见：
 * 三、通过信函方式将意见邮寄至：北京市西城区大木仓胡同35号…（邮编：100816）」，
 * 根本没有「通信地址」四个字——只认标签式会漏掉教育部、市场监管总局这类源。
 *
 * 刻意**不含**「发送至 / 反馈至 / 提交至」：那几个在原文里接的多是邮箱
 * （如「通过电子邮件方式将意见发送至：lssf@moj.gov.cn」），收进来会变成一条
 * 内容为邮箱的「通信地址」。冒号可选，因为「通过信函邮寄至北京市海淀区…」也常见。
 */
const ADDRESS_VERB = new RegExp(
  `(?:信函邮寄至|邮寄至|寄至)\\s*[:：]?\\s*([^\\n。；;]{6,80}(?:${ADDRESS_ZIP_TAIL})?)`,
  'g',
);

/** 正文里的 URL（排除句读与括号，避免把中文标点吃进链接） */
const URL_PATTERN = /https?:\/\/[^\s，,。；;、）)】」"'<>]+/g;

/**
 * 裸域名：司法部的主渠道写作「登录中国政府法制信息网（www.moj.gov.cn）」，
 * 教育部、生态环境部也大量出现不带协议的域名——只认 `https?://` 会漏掉整条
 * 在线提交入口。限定 `www.` 前缀或 `.gov.cn` 结尾，避免把正文里的普通词
 * （含点号的英文缩写、版本号）误判成网址；前置断言排除「已经在完整 URL 里」的
 * 情况（`https://www.mot.gov.cn` 中的 `www.mot.gov.cn` 前面是 `/`，不重复收）。
 */
const BARE_DOMAIN = /(?<![\w.@/])(?:www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|[A-Za-z0-9-]+\.gov\.cn)/g;

/** 附件与图片链接不算提交渠道（它们已在「附件清单」区展示） */
const FILE_SUFFIX = /\.(pdf|docx?|wps|xls[xm]?|zip|rar|png|jpe?g|gif|svg)$/i;

/** 站外噪声：备案号链接、本站自身域名 */
const NOISE_HOSTS = ['beian.miit.gov.cn', 'www.beian.gov.cn', 'cn101.top'];

/** 标题里的《…》（内层可能用〈〉，故只排除《》本身） */
const BOOK_TITLE = /《([^《》]{2,120})》/g;

/** 文件性质判定：按特异性降序，命中即止 */
const DOCUMENT_KINDS: { pattern: RegExp; label: string }[] = [
  { pattern: /反馈情况|意见反馈/, label: '意见反馈情况' },
  { pattern: /征求意见稿/, label: '征求意见稿' },
  { pattern: /报批/, label: '标准报批公示' },
  { pattern: /修正草案|修订草案|草案/, label: '草案' },
  { pattern: /公示/, label: '公示' },
  { pattern: /通知|公告/, label: '通知公告' },
];

/** 去掉号码里的分隔符，供 tel: 使用（010-64102958 → 01064102958） */
function dialable(number: string): string {
  return number.replace(/[-－\s]/g, '');
}

/**
 * 地址文本的清洗。两个真实的坑：
 *
 * 1. 有的正文两栏之间没有标点（「传真：010-68206220地址：北京市西城区…，邮寄时请
 *    在信封上注明"…"」），会一口气吞到下一个句号。以邮编括号为界截断——邮编是
 *    地址的天然结尾，三种写法都要认：「（邮编：100816）」「（邮政编码：100088）」
 *    以及只有数字的「（100710）」；
 * 2. 邮编括号之后的收尾语（「，并在信封上注明…」）同理需要切掉。
 *
 * 兜底拒绝邮箱与网址：它们不该被当成通信地址（动词式规则已排除「发送至」，
 * 这里再挡一层，规则改动时不至于悄悄退化）。
 */
function normalizeAddress(raw: string): string | null {
  const address = collapse(raw);
  if (address.length === 0) return null;
  if (address.includes('@') || /https?:\/\//.test(address)) return null;

  const zip = /(?:（|\().{0,6}?(?:邮\s*政?\s*编\s*码?|\d{6}).{0,12}?(?:）|\))/.exec(address);
  if (zip) return clip(address.slice(0, zip.index + zip[0].length), 60);

  // 没有邮编括号时，用「，+ 收尾动词」截断（逗号在地址内部是合法的，不能一刀切）
  const tail = /[，,](?:并|来信|请在|邮寄时|信封|邮件|注明|联系)/.exec(address);
  if (tail && tail.index >= 6) return clip(address.slice(0, tail.index), 60);

  return clip(address, 60);
}

/** 超长截断（补省略号）。 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 按标签抽取号码类渠道（电话 / 传真）。 */
function numberChannels(
  bodyText: string,
  pattern: RegExp,
  kind: 'phone' | 'fax',
): NoticeChannel[] {
  const channels: NoticeChannel[] = [];
  for (const match of bodyText.matchAll(pattern)) {
    const list = match[1];
    if (list === undefined) continue;
    const context = contextOf(bodyText, collapse(match[0]));
    for (const raw of list.split(/[，,、；;和及]/)) {
      const number = collapse(raw);
      if (number.length === 0) continue;
      channels.push({ kind, value: number, href: `tel:${dialable(number)}`, context });
    }
  }
  return channels;
}

/** 抽取原文注明的提交渠道（去重、保序、限量）。 */
export function extractChannels(
  bodyText: string | null | undefined,
  options: { pageUrl?: string } = {},
): NoticeChannel[] {
  if (!bodyText) return [];
  const channels: NoticeChannel[] = [];

  // 1) 在线入口：完整 URL 与裸域名两种写法（排除附件、备案、本站自身）
  const seenHrefs = new Set<string>();
  const pushOnline = (raw: string, href: string): void => {
    if (FILE_SUFFIX.test(href)) return;
    if (options.pageUrl !== undefined && href === options.pageUrl) return;
    let host: string;
    try {
      host = new URL(href).host;
    } catch {
      return;
    }
    if (NOISE_HOSTS.includes(host)) return;
    if (seenHrefs.has(href)) return;
    seenHrefs.add(href);
    channels.push({ kind: 'online', value: href, href, context: contextOf(bodyText, raw) });
  };
  for (const match of bodyText.matchAll(URL_PATTERN)) {
    pushOnline(match[0], match[0]);
  }
  for (const match of bodyText.matchAll(BARE_DOMAIN)) {
    pushOnline(match[0], `http://${match[0]}`);
  }

  // 2) 电子邮箱
  const seenEmails = new Set<string>();
  for (const match of bodyText.matchAll(EMAIL_PATTERN)) {
    const email = match[0];
    const key = email.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    channels.push({
      kind: 'email',
      value: email,
      href: `mailto:${email}`,
      context: contextOf(bodyText, email),
    });
  }

  // 3) 通信地址
  const seenAddresses = new Set<string>();
  const pushAddress = (raw: string | undefined): void => {
    const address = normalizeAddress(raw ?? '');
    if (address === null || seenAddresses.has(address)) return;
    seenAddresses.add(address);
    channels.push({
      kind: 'address',
      value: address,
      href: null,
      context: contextOf(bodyText, address),
    });
  };
  for (const match of bodyText.matchAll(ADDRESS_LABEL)) pushAddress(match[1]);
  for (const match of bodyText.matchAll(ADDRESS_VERB)) pushAddress(match[1]);

  // 4) 电话 / 传真
  channels.push(...numberChannels(bodyText, PHONE_LABEL, 'phone'));
  channels.push(...numberChannels(bodyText, FAX_LABEL, 'fax'));

  // 同一号码被两个标签重复捕获时（如「联系电话及传真」），保留先出现的那个
  const seenValues = new Set<string>();
  const deduped = channels.filter((channel) => {
    const key = `${channel.kind}:${channel.value.toLowerCase()}`;
    if (seenValues.has(key)) return false;
    seenValues.add(key);
    return true;
  });

  return deduped.slice(0, MAX_CHANNELS);
}

/** 抽取标题里的文件名称（《…》），去重保序。 */
export function extractDocumentNames(title: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of title.matchAll(BOOK_TITLE)) {
    const name = collapse(match[1] ?? '');
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 判定文件性质（命中不了返回 null——不猜）。 */
export function detectDocumentKind(title: string): string | null {
  for (const { pattern, label } of DOCUMENT_KINDS) {
    if (pattern.test(title)) return label;
  }
  return null;
}

/**
 * 正文首段：取第一段「像正文」的文字。
 *
 * 跳过两类噪声：与标题重复的行（部分站点正文首块就是标题）、以及只有发文机关
 * 与日期的落款行（如「交通运输部2026年9月7日」——它常在正文里被排到最前）。
 */
export function extractLeadParagraph(
  bodyText: string | null | undefined,
  title: string,
): string | null {
  if (!bodyText) return null;
  const normalizedTitle = collapse(title);
  const byline = /^[^\s]{2,12}\d{4}年\d{1,2}月\d{1,2}日$/;

  const picked: string[] = [];
  let length = 0;
  for (const sentence of sentences(bodyText)) {
    if (picked.length === 0) {
      if (sentence.length < MIN_LEAD_LENGTH) continue;
      if (normalizedTitle.includes(sentence) || sentence.includes(normalizedTitle)) continue;
      if (byline.test(sentence)) continue;
    }
    picked.push(sentence);
    length += sentence.length;
    if (length >= 60) break;
    if (picked.length >= 3) break;
  }
  if (picked.length === 0) return null;
  return truncate(picked.join(''), MAX_LEAD_LENGTH);
}

/**
 * 分条标记：`一、` `（三）` `1.` `2、` `(4)`。
 *
 * 必须落在句首——行首、句读之后，或引导语冒号之后（「提出反馈意见：一、登录…」是
 * 最常见的写法）。用后置断言而不是 `^` 锚定：分条既可能换行排（教育部），也可能
 * 挤在同一段里（交通运输部）。断言同时挡住了正文里的日期数字——「时间：2026.1.1」
 * 里的 `26.` 前面是 `0` 而不是边界，不会被当成分条。
 */
const ITEM_MARKER = /(?<=^|[\n。；;：:])\s*(?:[一二三四五六七八九十]{1,3}[、.．]|（[一二三四五六七八九十]{1,3}）|[（(]\d{1,2}[）)]|\d{1,2}[、.．])\s*/gm;

/** 单条要点与总条数的上限：速读要短，超出的留给下方正文 */
const MAX_KEY_ITEMS = 5;
const MIN_KEY_ITEM_LENGTH = 10;
const MAX_KEY_ITEM_LENGTH = 140;

/**
 * 原文分条要点：把「一、二、三、」这类分条**逐字**摘出来。
 *
 * 这不是摘要——一个字都不改写，只是把原文已经分好的条摆成列表，让读者在
 * 没有 AI 摘要时也能一眼看到公告分了几件事。两条自律：
 * - 只取标记**之后**的文字，标记之前的引导段不算要点（否则「公众可通过以下途径…」
 *   会变成第一条）；
 * - 每条只取到第一个句末标点，避免一条吞掉整段。
 *
 * 不足两条时返回空数组：只有一条「要点」不构成速读，页面不渲染该块。
 */
export function extractKeyItems(bodyText: string | null | undefined): string[] {
  if (!bodyText) return [];
  const markers = [...bodyText.matchAll(ITEM_MARKER)];
  const items: string[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const start = marker.index + marker[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : bodyText.length;
    const slice = collapse(bodyText.slice(start, end));
    const stop = /[。；;]/.exec(slice);
    const item = collapse(stop ? slice.slice(0, stop.index + 1) : slice);
    if (item.length < MIN_KEY_ITEM_LENGTH) continue;
    items.push(clip(item, MAX_KEY_ITEM_LENGTH));
    if (items.length >= MAX_KEY_ITEMS) break;
  }
  return items.length >= 2 ? items : [];
}

/** 由条目字段构造结构化速读（纯函数，详情页在请求期调用）。 */
export function buildNoticeBrief(notice: {
  title: string;
  bodyText: string | null;
  url: string;
}): NoticeBrief {
  return {
    documentNames: extractDocumentNames(notice.title),
    documentKind: detectDocumentKind(notice.title),
    channels: extractChannels(notice.bodyText, { pageUrl: notice.url }),
    leadParagraph: extractLeadParagraph(notice.bodyText, notice.title),
    keyItems: extractKeyItems(notice.bodyText),
  };
}

/** 速读卡是否有内容可渲染（全空则不渲染整块，避免空卡片）。 */
export function hasBriefContent(brief: NoticeBrief): boolean {
  return (
    brief.channels.length > 0 ||
    brief.documentNames.length > 0 ||
    brief.leadParagraph !== null ||
    brief.keyItems.length > 0
  );
}
