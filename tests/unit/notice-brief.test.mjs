import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildNoticeBrief,
  detectDocumentKind,
  extractChannels,
  extractDocumentNames,
  extractKeyItems,
  extractLeadParagraph,
  hasBriefContent,
} from '../../src/lib/notice-brief.ts';

/**
 * 单元：结构化速读的确定性抽取（issue #26）。
 *
 * 定位是「AI 摘要的降级路径」：大模型密钥没就绪时，详情页仍要能告诉读者
 * **意见往哪儿提交**。下面每一段正文都是**线上真实抓到的原文**（取自
 * fixtures/e2e-sources 的快照，仅把 {{DATE±N}} 占位符换成具体日期），
 * 覆盖八个源里实际出现的四种写法差异：
 *
 * 1. 标签式「通信地址：」——交通运输部；
 * 2. 裸域名「（www.moj.gov.cn）」——司法部，无协议前缀；
 * 3. 动词式「通过信函方式将意见邮寄至：」——教育部，全文没有「通信地址」四字；
 * 4. 无标点连排「传真：…地址：…」——工业和信息化部，两栏之间连逗号都没有。
 *
 * 第 3 种最容易误伤：同段的「通过电子邮件方式将意见发送至：xxx@xx.gov.cn」如果
 * 也按动词式收进来，会得到一条内容是邮箱的「通信地址」——故规则里刻意不含「发送至」。
 */

/** 交通运输部「意见征集」详情页正文（标签式全渠道）。 */
const MOT_BODY = [
  '为深入贯彻落实党的二十届三中全会关于推动收费公路政策优化的部署，促进公路高质量发展，交通运输部研究起草了《中华人民共和国公路法（修正草案征求意见稿）》，现向社会公开征求意见。',
  '公众可通过以下途径和方式提出反馈意见：一、登录交通运输部政府网站（网址：https://www.mot.gov.cn），进入首页右侧的“互动”栏“意见征集”，提出意见建议。二、电子邮箱：glfzqyj@mot.gov.cn。三、通信地址：北京市东城区建国门内大街11号，交通运输部收，邮编：100736。',
  '请在电子邮件主题或者信封上注明“公路法修正草案意见”字样。',
  '意见反馈截止日期为2026年9月24日。',
  '交通运输部2026年9月7日',
].join('\n');

const MOT_TITLE = '交通运输部关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知';

/** 司法部：主渠道写作裸域名，且「发送至」后接的是邮箱。 */
const MOJ_BODY = [
  '《中华人民共和国律师法（修订草案）》，现向社会公开征求意见。',
  '一、登录中国政府法制信息网（www.moj.gov.cn），进入「立法意见征集」栏目提出意见。',
  '二、通过电子邮件方式将意见发送至：lssf@moj.gov.cn。',
  '征求意见时间为2026年9月17日至2026年9月24日。',
].join('\n');

/** 教育部：动词式邮寄地址，无「通信地址」字样。 */
const MOE_BODY = [
  '公众可通过以下途径和方式提出反馈意见：1.通过信函方式将意见邮寄至：北京市西城区大木仓胡同35号教育部政策法规司法制办（邮编：100816）。来信请注明“《中华人民共和国教师法》征求意见”字样。2.通过电子邮件方式将意见发送至：fzb@moe.edu.cn。',
].join('\n');

/** 市场监管总局：动词式且冒号可省，「邮政编码」是四字写法。 */
const SAMR_BODY = [
  '一、通过登录国家市场监督管理总局官方网站（网址：http://www.samr.gov.cn），在首页“互动”栏目中的“征集调查”提出意见。',
  '二、通过电子邮件发送至wljyjgc@samr.gov.cn,邮件主题请注明“网络交易小程序平台合规指引”字样。',
  '三、通过信函邮寄至北京市海淀区马甸东路9号市场监管总局网监司（邮政编码：100088），并在信封上注明“网络交易小程序平台合规指引”字样。',
].join('\n');

/** 工业和信息化部无线电管理局：传真与地址之间没有任何标点。 */
const MIIT_RADIO_BODY = [
  '我局修订了《中华人民共和国无线电频率划分规定》，现向社会公开征求意见。请于2026年10月14日前反馈意见。',
  '联系方式：电话：010-68206251传真：010-68206220地址：北京市西城区西长安街13号 工业和信息化部无线电管理局（邮编：100804），邮寄时请在信封上注明“《中华人民共和国无线电频率划分规定》征求意见”字样。',
].join('\n');

/** 按类型取出渠道值，便于断言。 */
function valuesOf(channels, kind) {
  return channels.filter((channel) => channel.kind === kind).map((channel) => channel.value);
}

describe('extractChannels：标签式全渠道（交通运输部实测写法）', () => {
  const channels = extractChannels(MOT_BODY, { pageUrl: 'https://www.mot.gov.cn/detail.html' });

  it('三种渠道都抽到，且顺序为 在线 → 邮箱 → 地址', () => {
    assert.deepEqual(
      channels.map((channel) => channel.kind),
      ['online', 'email', 'address'],
    );
  });

  it('在线入口是完整 URL，且带可点击 href', () => {
    assert.deepEqual(valuesOf(channels, 'online'), ['https://www.mot.gov.cn']);
    assert.equal(channels[0].href, 'https://www.mot.gov.cn');
  });

  it('邮箱带 mailto:', () => {
    assert.deepEqual(valuesOf(channels, 'email'), ['glfzqyj@mot.gov.cn']);
    assert.equal(channels[1].href, 'mailto:glfzqyj@mot.gov.cn');
  });

  it('通信地址按「通信地址：」标签取值，逗号不被切断（邮编在其中）', () => {
    assert.deepEqual(valuesOf(channels, 'address'), [
      '北京市东城区建国门内大街11号，交通运输部收，邮编：100736',
    ]);
    assert.equal(channels[2].href, null, '地址不可点击');
  });

  it('每条渠道都带原文上下文片段，供读者核对', () => {
    for (const channel of channels) {
      assert.ok(channel.context !== null, `${channel.kind} 缺上下文`);
      assert.ok(channel.context.length <= 121, '上下文应截断到 120 字以内');
    }
    assert.match(channels[1].context, /电子邮箱：glfzqyj@mot\.gov\.cn/);
  });
});

describe('extractChannels：裸域名在线入口（司法部实测写法）', () => {
  const channels = extractChannels(MOJ_BODY);

  it('无协议前缀的 www.moj.gov.cn 也要抽到，补 http:// 作为 href', () => {
    assert.deepEqual(valuesOf(channels, 'online'), ['http://www.moj.gov.cn']);
    assert.equal(channels[0].href, 'http://www.moj.gov.cn');
  });

  it('「发送至：邮箱」不得被当成通信地址', () => {
    assert.deepEqual(valuesOf(channels, 'address'), []);
    assert.deepEqual(valuesOf(channels, 'email'), ['lssf@moj.gov.cn']);
  });
});

describe('extractChannels：动词式邮寄地址（教育部实测写法）', () => {
  const channels = extractChannels(MOE_BODY);

  it('「通过信函方式将意见邮寄至：」后的地址要抽到，并在邮编括号处收尾', () => {
    assert.deepEqual(valuesOf(channels, 'address'), [
      '北京市西城区大木仓胡同35号教育部政策法规司法制办（邮编：100816）',
    ]);
  });

  it('同一段的「发送至：邮箱」仍只算邮箱', () => {
    assert.deepEqual(valuesOf(channels, 'email'), ['fzb@moe.edu.cn']);
  });
});

describe('extractChannels：冒号可省 + 「邮政编码」四字写法（市场监管总局实测写法）', () => {
  const channels = extractChannels(SAMR_BODY);

  it('「通过信函邮寄至」后无冒号也能抽到', () => {
    assert.deepEqual(valuesOf(channels, 'address'), [
      '北京市海淀区马甸东路9号市场监管总局网监司（邮政编码：100088）',
    ]);
  });

  it('完整 URL 不会被裸域名规则重复收一条', () => {
    assert.deepEqual(valuesOf(channels, 'online'), ['http://www.samr.gov.cn']);
  });

  it('半角逗号紧跟在邮箱后不影响抽取', () => {
    assert.deepEqual(valuesOf(channels, 'email'), ['wljyjgc@samr.gov.cn']);
  });
});

describe('extractChannels：无标点连排（工业和信息化部实测写法）', () => {
  const channels = extractChannels(MIIT_RADIO_BODY);

  it('电话与传真各抽一条（「联系方式：电话：」的叠标签不误吞）', () => {
    assert.deepEqual(valuesOf(channels, 'phone'), ['010-68206251']);
    assert.deepEqual(valuesOf(channels, 'fax'), ['010-68206220']);
  });

  it('电话可拨号：tel: 去掉连字符', () => {
    const phone = channels.find((channel) => channel.kind === 'phone');
    assert.equal(phone.href, 'tel:01068206251');
  });

  it('地址在邮编括号处截断，不把后面的「邮寄时请在信封上注明…」吞进来', () => {
    assert.deepEqual(valuesOf(channels, 'address'), [
      '北京市西城区西长安街13号 工业和信息化部无线电管理局（邮编：100804）',
    ]);
  });
});

describe('extractChannels：地址尾部的「分号 + 邮编」（住建部实测写法）', () => {
  // 生产库实测（2026-09-20，170 条里 28 条）正文写作「…C座18层；邮编：100013」：
  // 分号本是句读边界，但邮编是地址的一部分，邮寄意见时必须带上。
  const body =
    '有关单位和公众可通过以下途径和方式提出反馈意见：1.电子邮箱：zuqiwang@126.com。2.通信地址：北京市朝阳区北三环东路30号中国建筑科学研究院有限公司C座18层；邮编：100013。意见反馈截止时间为2026年9月21日。';

  it('分号后的邮编并入地址值，不被句读切断', () => {
    assert.deepEqual(valuesOf(extractChannels(body), 'address'), [
      '北京市朝阳区北三环东路30号中国建筑科学研究院有限公司C座18层；邮编：100013',
    ]);
  });

  it('「邮政编码」四字写法与「，邮编」写法同样并入', () => {
    const variants = extractChannels(
      '通信地址：北京市西城区三里河路9号；邮政编码：100835。通信地址：北京市海淀区甲1号，邮编：100084。',
    );
    assert.deepEqual(valuesOf(variants, 'address'), [
      '北京市西城区三里河路9号；邮政编码：100835',
      '北京市海淀区甲1号，邮编：100084',
    ]);
  });

  it('邮编之后的内容不并入（收尾语仍被切掉）', () => {
    const [address] = valuesOf(
      extractChannels('通信地址：北京市西城区甲1号；邮编：100000，并请在信封上注明“意见”字样。'),
      'address',
    );
    assert.equal(address, '北京市西城区甲1号；邮编：100000');
    assert.ok(!address.includes('并请在信封上注明'), '邮编之后是收尾语，不属于地址');
  });
});

describe('extractChannels：噪声过滤', () => {
  it('附件、备案链接、本站域名都不算提交渠道', () => {
    const body = [
      '公众可登录中国政府网（www.gov.cn）在线提出意见，或发送邮件至 yijian@example.gov.cn。',
      '相关附件见 http://www.example.gov.cn/draft.pdf，备案信息见 https://beian.miit.gov.cn。',
    ].join('\n');
    const channels = extractChannels(body, { pageUrl: 'https://cn101.top/notices/x' });
    assert.deepEqual(valuesOf(channels, 'online'), ['http://www.gov.cn']);
    assert.deepEqual(valuesOf(channels, 'email'), ['yijian@example.gov.cn']);
  });

  it('条目自身 URL 不作为在线渠道（原文里回指自己时）', () => {
    const body = '本文地址：https://www.mot.gov.cn/detail.html。电子邮箱：a@mot.gov.cn。';
    const channels = extractChannels(body, { pageUrl: 'https://www.mot.gov.cn/detail.html' });
    assert.deepEqual(valuesOf(channels, 'online'), []);
  });

  it('重复出现的同一邮箱只保留一条（大小写不敏感）', () => {
    const body = '邮箱：A@mot.gov.cn。邮箱：a@MOT.gov.cn。';
    assert.deepEqual(valuesOf(extractChannels(body), 'email'), ['A@mot.gov.cn']);
  });

  it('无正文 / 空串返回空数组（页面据此不渲染该块）', () => {
    assert.deepEqual(extractChannels(null), []);
    assert.deepEqual(extractChannels(''), []);
    assert.deepEqual(extractChannels(undefined), []);
  });

  it('渠道数量封顶 8 条，避免畸形正文把整页塞满', () => {
    const emails = Array.from({ length: 12 }, (_, index) => `box${index}@mot.gov.cn`).join('、');
    assert.equal(extractChannels(`邮箱：${emails}`).length, 8);
  });

  it('正文里只有普通文字时，一条渠道都不编', () => {
    assert.deepEqual(extractChannels('本规定自2026年10月1日起施行，请遵照执行。'), []);
  });
});

describe('文件名称与性质（标题抽取）', () => {
  it('抽出《…》里的文件名，内层〈〉不受影响', () => {
    assert.deepEqual(
      extractDocumentNames(
        '交通运输部关于公开征求《关于修改〈中华人民共和国船舶油污损害民事责任保险实施办法〉的决定（征求意见稿）》意见的通知',
      ),
      ['关于修改〈中华人民共和国船舶油污损害民事责任保险实施办法〉的决定（征求意见稿）'],
    );
  });

  it('同一名称重复出现只留一条', () => {
    assert.deepEqual(extractDocumentNames('《公路法（修正草案征求意见稿）》公开征求意见的通知'), [
      '公路法（修正草案征求意见稿）',
    ]);
  });

  it('标题没有《》时返回空数组，不瞎猜文件名', () => {
    assert.deepEqual(extractDocumentNames('关于公开征求某项意见的公告'), []);
  });

  it('文件性质按特异性降序判定', () => {
    assert.equal(detectDocumentKind('关于《公路法（修正草案征求意见稿）》征求意见的通知'), '征求意见稿');
    assert.equal(detectDocumentKind('关于公开征求《XX办法》意见的公告'), '通知公告');
    assert.equal(detectDocumentKind('关于《XX》公开征求意见反馈情况的说明'), '意见反馈情况');
    assert.equal(detectDocumentKind('关于XX项国家标准报批意见的公示'), '标准报批公示');
    assert.equal(detectDocumentKind('某项无关键词的标题'), null);
  });
});

describe('extractLeadParagraph：首段摘录', () => {
  it('跳过与标题重复的首块，取真正的正文首句', () => {
    const lead = extractLeadParagraph(MOT_BODY, MOT_TITLE);
    assert.match(lead, /^为深入贯彻落实党的二十届三中全会/);
    assert.ok(!lead.includes('交通运输部2026年9月7日'), '落款行不应混入首段');
  });

  it('跳过过短的引导行（如栏目名、日期行）', () => {
    const body = ['意见征集', '为规范公路建设项目管理，现就《公路建设项目可行性研究报告编制办法（征求意见稿）》公开征求意见。'].join('\n');
    assert.match(extractLeadParagraph(body, '某标题'), /^为规范公路建设项目管理/);
  });

  it('落款行单独出现时不作为首段（避免「交通运输部2026年9月7日」当正文）', () => {
    assert.equal(extractLeadParagraph('交通运输部2026年9月7日', MOT_TITLE), null);
  });

  it('无正文返回 null', () => {
    assert.equal(extractLeadParagraph(null, MOT_TITLE), null);
  });
});

describe('extractKeyItems：原文分条要点（逐字，不改写）', () => {
  it('同一段里的「一、二、三、」也切得开，且引导段不算要点', () => {
    const items = extractKeyItems(MOT_BODY);
    assert.equal(items.length, 3);
    assert.match(items[0], /^登录交通运输部政府网站/);
    assert.match(items[1], /^电子邮箱：glfzqyj@mot\.gov\.cn。$/);
    assert.match(items[2], /^通信地址：北京市东城区建国门内大街11号/);
    assert.ok(
      items.every((item) => !item.includes('公众可通过以下途径')),
      '引导段不应成为要点',
    );
  });

  it('阿拉伯数字分条（教育部 1. 2. 写法）同样识别', () => {
    const items = extractKeyItems(MOE_BODY);
    assert.equal(items.length, 2);
    assert.match(items[0], /^通过信函方式将意见邮寄至：/);
    assert.match(items[1], /^通过电子邮件方式将意见发送至：fzb@moe\.edu\.cn。$/);
  });

  it('每条只取到第一个句末标点，不吞掉后续整段', () => {
    const items = extractKeyItems(MOT_BODY);
    for (const item of items) {
      assert.ok(item.length <= 140, '单条要点应截断到 140 字以内');
    }
    assert.ok(!items[2].includes('意见反馈截止日期'), '不应把落款与截止句并进最后一条');
  });

  it('正文里的日期数字不被误判为分条（「时间：2026.1.1」）', () => {
    assert.deepEqual(extractKeyItems('征求意见时间：2026.1.1至2026.2.1。'), []);
  });

  it('不足两条时不输出（一条不构成速读）', () => {
    assert.deepEqual(extractKeyItems('一、这是唯一的一条要点，超过十个字了。'), []);
    assert.deepEqual(extractKeyItems('正文没有任何分条标记，只是普通段落。'), []);
    assert.deepEqual(extractKeyItems(null), []);
  });
});

describe('buildNoticeBrief：整卡组装', () => {  it('把文件名、性质、渠道、首段组装成速读卡', () => {
    const brief = buildNoticeBrief({
      title: MOT_TITLE,
      bodyText: MOT_BODY,
      url: 'https://www.mot.gov.cn/detail.html',
    });
    assert.deepEqual(brief.documentNames, ['中华人民共和国公路法（修正草案征求意见稿）']);
    assert.equal(brief.documentKind, '征求意见稿');
    assert.equal(brief.channels.length, 3);
    assert.match(brief.leadParagraph, /^为深入贯彻落实/);
    assert.equal(hasBriefContent(brief), true);
  });

  it('正文与文件名全空时 hasBriefContent 为 false（详情页不渲染空卡）', () => {
    const brief = buildNoticeBrief({ title: '无书名号的标题', bodyText: null, url: 'https://x.test/a' });
    assert.deepEqual(brief.channels, []);
    assert.deepEqual(brief.documentNames, []);
    assert.equal(brief.leadParagraph, null);
    assert.equal(hasBriefContent(brief), false);
  });
});
