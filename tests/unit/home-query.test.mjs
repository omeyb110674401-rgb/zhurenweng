import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeHomeQuery,
  firstParam,
  monthParam,
  monthRangeParam,
  openOnlyParam,
  pageParam,
  parseHomeQuery,
  periodParam,
  sinceParam,
  sortParam,
  subFeedHref,
} from '../../src/app/_lib/home-query.ts';

/**
 * 单元：首页 querystring 解析（issue #41）。
 *
 * 这份解析现在由**页面渲染与 generateMetadata 共用** —— 它同时决定「筛选后共 N 条」
 * 的文案、翻页链接，以及这一页要不要 noindex。抽出来之前两处各写一份，迟早分叉
 * （issue #32/#33 的教训：同一个口径有两份实现，最后给出相反答案）。这里钉死边界：
 * 空串 / 数组 / 非正整数页码 / 未知领域值。
 */

describe('firstParam：querystring 首值', () => {
  it('数组取首值、去空白、空串视为未传', () => {
    assert.equal(firstParam(['a', 'b']), 'a');
    assert.equal(firstParam('  x  '), 'x');
    assert.equal(firstParam(''), undefined);
    assert.equal(firstParam('   '), undefined);
    assert.equal(firstParam(undefined), undefined);
  });
});

describe('pageParam：页码', () => {
  it('正整数照用，数组取首值', () => {
    assert.equal(pageParam('1'), 1);
    assert.equal(pageParam('2'), 2);
    assert.equal(pageParam('999'), 999);
    assert.equal(pageParam(['3', '4']), 3);
  });

  it('非正整数 / 非数字一律回落第 1 页（不报错、不空页）', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '   ', undefined]) {
      assert.equal(pageParam(bad), 1, `page=${JSON.stringify(bad)} 应回落第 1 页`);
    }
  });
});

describe('monthParam：发布月份（issue #45）', () => {
  it('接受 YYYY-MM，补零必需（2026-8 不是合法月份值）', () => {
    assert.equal(monthParam('2026-08'), '2026-08');
    assert.equal(monthParam('2026-01'), '2026-01');
    assert.equal(monthParam('2026-12'), '2026-12');
    assert.equal(monthParam(' 2026-09 '), '2026-09', '去空白后仍合法');
  });

  it('非法值一律不生效（与未知领域值同一处理，不报错、不空页）', () => {
    for (const bad of ['2026-13', '2026-00', '2026-8', '26-08', '2026-08-01', '2026', 'abc', '%', '2026-%', '', '   ', undefined]) {
      assert.equal(monthParam(bad), undefined, `month=${JSON.stringify(bad)} 应不生效`);
    }
  });
});

describe('monthRangeParam：发布月份区间（issue #48）', () => {
  it('两端合法 → 原样返回；只给一端也有效', () => {
    assert.deepEqual(monthRangeParam('2026-04', '2026-09'), { from: '2026-04', to: '2026-09' });
    assert.deepEqual(monthRangeParam('2026-04', undefined), { from: '2026-04', to: undefined });
    assert.deepEqual(monthRangeParam(undefined, '2026-09'), { from: undefined, to: '2026-09' });
    assert.deepEqual(monthRangeParam(undefined, undefined), { from: undefined, to: undefined });
  });

  it('from > to → 两端都不生效（宁可不筛，也不给一页假空态）', () => {
    assert.deepEqual(monthRangeParam('2026-09', '2026-04'), {});
  });

  it('格式非法的一端不生效，另一端照常', () => {
    assert.deepEqual(monthRangeParam('2026-13', '2026-09'), { from: undefined, to: '2026-09' });
    assert.deepEqual(monthRangeParam('2026-04', 'abc'), { from: '2026-04', to: undefined });
  });
});

describe('periodParam：公示期分桶（issue #47）', () => {
  it('只认 notice-period.ts 定义过的桶 key', () => {
    for (const key of ['lte7', 'b8_15', 'b16_30', 'gt30']) {
      assert.equal(periodParam(key), key);
    }
  });

  it('非法值一律不生效（与未知领域值同一处理）', () => {
    for (const bad of ['lte8', 'gt31', '7', 'LTE7', 'b8-15', 'unknown', '', '   ', undefined]) {
      assert.equal(periodParam(bad), undefined, `period=${JSON.stringify(bad)} 应不生效`);
    }
  });
});

describe('parseHomeQuery：筛选状态与索引口径', () => {
  it('未知领域值不生效（避免任意 querystring 触发无效筛选）', () => {
    assert.equal(parseHomeQuery({ category: '生态环境' }).category, '生态环境');
    assert.equal(parseHomeQuery({ category: '不存在的领域' }).category, undefined);
    assert.equal(parseHomeQuery({ category: '不存在的领域' }).hasFilter, false);
  });

  it('hasFilter 只看筛选维度（翻页与 lead 都不算）', () => {
    assert.equal(parseHomeQuery({}).hasFilter, false);
    assert.equal(parseHomeQuery({ page: '2' }).hasFilter, false, '翻页不是筛选');
    assert.equal(parseHomeQuery({ lead: '1' }).hasFilter, false, '裸 lead 不改变结果');
    assert.equal(parseHomeQuery({ q: '意见' }).hasFilter, true);
    assert.equal(parseHomeQuery({ agency: '司法部' }).hasFilter, true);
    assert.equal(parseHomeQuery({ month: '2026-08' }).hasFilter, true, '月份是筛选维度（issue #45）');
    assert.equal(parseHomeQuery({ month: '2026-13' }).hasFilter, false, '非法月份不生效');
    assert.equal(parseHomeQuery({ period: 'b16_30' }).hasFilter, true, '公示期是筛选维度（issue #47）');
    assert.equal(parseHomeQuery({ period: 'nope' }).hasFilter, false, '非法桶 key 不生效');
    assert.equal(parseHomeQuery({ from: '2026-04' }).hasFilter, true, '区间下界是筛选维度');
    assert.equal(parseHomeQuery({ to: '2026-09' }).hasFilter, true, '区间上界是筛选维度');
    assert.equal(
      parseHomeQuery({ from: '2026-09', to: '2026-04' }).hasFilter,
      false,
      '倒置区间不生效（也就不是筛选）',
    );
  });

  it('?month= 是 from = to 的别名（issue #45 已发布的链接保持有效）', () => {
    const legacy = parseHomeQuery({ month: '2026-08' });
    assert.equal(legacy.from, '2026-08');
    assert.equal(legacy.to, '2026-08');
    assert.equal(legacy.hasFilter, true);
    // 显式区间优先于别名
    const explicit = parseHomeQuery({ month: '2026-08', from: '2026-01', to: '2026-06' });
    assert.equal(explicit.from, '2026-01');
    assert.equal(explicit.to, '2026-06');
  });

  it('半区间 + 别名：别名不补另一侧（不凭空造出区间）', () => {
    // 这是**不变量钉子**，不是修缺陷：旧实现的镜像守卫（`range.to === undefined ? 别名 : undefined`）
    // 在四种输入下与新实现完全等价，已逐例核对过。issue #50 只是把两个互为镜像的内联条件
    // 收成一个有名字的 `hasRange` —— 读者不必再自己推「哪一侧缺省时才认别名」。
    // 钉住的性质：别名只在**两端都没给区间**时生效，绝不会补上缺的那一侧。
    const halfLower = parseHomeQuery({ from: '2026-01', month: '2026-03' });
    assert.equal(halfLower.from, '2026-01');
    assert.equal(halfLower.to, undefined, '上界不该被别名填上');

    const halfUpper = parseHomeQuery({ to: '2026-03', month: '2026-01' });
    assert.equal(halfUpper.to, '2026-03');
    assert.equal(halfUpper.from, undefined, '下界不该被别名填上');
  });

  it('lead=1 只在显式传 1 时为真，其余值一律假', () => {
    assert.equal(parseHomeQuery({ lead: '1' }).leadAgencyOnly, true);
    for (const value of ['0', 'true', '', undefined]) {
      assert.equal(parseHomeQuery({ lead: value }).leadAgencyOnly, false, `lead=${value} 应为假`);
    }
  });

  it('筛选与页码可以并存（索引口径由 hasFilter 决定，与页码无关）', () => {
    assert.deepEqual(parseHomeQuery({ q: '意见', page: '3' }), {
      category: undefined,
      // 受众面（issue #83）：与领域正交的第二个分类维度，同样进 hasFilter
      audience: undefined,
      agency: undefined,
      keyword: '意见',
      from: undefined,
      to: undefined,
      period: undefined,
      source: undefined,
      sort: undefined,
      openOnly: false,
      sinceDays: undefined,
      leadAgencyOnly: false,
      page: 3,
      hasFilter: true,
    });
  });
});

describe('sortParam / openOnlyParam / sinceParam：排序与收录范围（issue #62）', () => {
  it('排序只认 notice-sort.ts 清单里的档位，未知值不生效（= 默认排序）', () => {
    for (const key of ['deadline', 'published', 'newest', 'clicks']) {
      assert.equal(sortParam(key), key);
    }
    for (const bad of ['Deadline', 'title', 'old', '__proto__', '', '   ', undefined]) {
      assert.equal(sortParam(bad), undefined, `sort=${JSON.stringify(bad)} 应不生效`);
    }
  });

  it('换排序**不算筛选**：结果集合没变，不该因此多出一堆 noindex 变体', () => {
    assert.equal(parseHomeQuery({ sort: 'newest' }).hasFilter, false);
    assert.equal(parseHomeQuery({ sort: 'newest' }).sort, 'newest');
    // 但和其他筛选一起用时，那一筛说了算
    assert.equal(parseHomeQuery({ sort: 'newest', q: '意见' }).hasFilter, true);
  });

  it('open 只认 1（与 lead 同一形状），其余值一律不筛', () => {
    assert.equal(openOnlyParam('1'), true);
    for (const value of ['0', 'true', 'yes', '', '   ', undefined]) {
      assert.equal(openOnlyParam(value), false, `open=${JSON.stringify(value)} 应为假`);
    }
    assert.equal(parseHomeQuery({ open: '1' }).openOnly, true);
    assert.equal(parseHomeQuery({ open: '1' }).hasFilter, true, '只看未截止是筛选维度');
  });

  it('since 认 1..90 的整数', () => {
    assert.equal(sinceParam('7'), 7);
    assert.equal(sinceParam('90'), 90);
    assert.equal(sinceParam('1'), 1);
  });

  it('since 越界不夹取、直接不生效：夹到 90 会给出比读者要求的更窄的一页', () => {
    assert.equal(sinceParam('91'), undefined);
    assert.equal(sinceParam('99999'), undefined);
    assert.equal(sinceParam('0'), undefined);
    assert.equal(sinceParam('-7'), undefined);
    assert.equal(sinceParam('7.5'), undefined);
    assert.equal(sinceParam('abc'), undefined);
    assert.equal(sinceParam(''), undefined);
    assert.equal(parseHomeQuery({ since: '99999' }).hasFilter, false, '不生效就不该算筛选');
  });
});

describe('describeHomeQuery / subFeedHref：条件的说法与地址（issue #63）', () => {
  it('每个维度都有且只有一种说法，组合顺序稳定', () => {
    assert.equal(describeHomeQuery(parseHomeQuery({})), '');
    assert.equal(describeHomeQuery(parseHomeQuery({ category: '生态环境' })), '生态环境');
    assert.equal(describeHomeQuery(parseHomeQuery({ agency: '司法部' })), '机关：司法部');
    assert.equal(
      describeHomeQuery(parseHomeQuery({ agency: '司法部', lead: '1' })),
      '机关（牵头）：司法部',
    );
    assert.equal(describeHomeQuery(parseHomeQuery({ q: '噪声' })), '关键词：噪声');
    assert.equal(describeHomeQuery(parseHomeQuery({ month: '2026-08' })), '发布月份：2026-08');
    assert.equal(
      describeHomeQuery(parseHomeQuery({ from: '2026-04', to: '2026-09' })),
      '发布区间：2026-04 至 2026-09',
    );
    assert.equal(describeHomeQuery(parseHomeQuery({ period: 'lte7' })), '公示期：7 天以内（含 7 天）');
    assert.equal(describeHomeQuery(parseHomeQuery({ open: '1' })), '只看未截止');
    assert.equal(describeHomeQuery(parseHomeQuery({ since: '7' })), '最近 7 天收录');
    assert.equal(
      describeHomeQuery(parseHomeQuery({ category: '生态环境', open: '1', since: '30' })),
      '生态环境 · 只看未截止 · 最近 30 天收录',
      '顺序是固定的：两处（首页摘要行 / feed 标题）拼出的必须是同一个串',
    );
  });

  it('裸 lead=1 不说成牵头口径（没有机关筛选时它不改变任何结果）', () => {
    assert.equal(describeHomeQuery(parseHomeQuery({ lead: '1' })), '');
  });

  it('子 feed 地址只带真正生效的维度，且不含 sort / page', () => {
    assert.equal(subFeedHref(parseHomeQuery({})), '/feed.xml');
    assert.equal(
      subFeedHref(parseHomeQuery({ category: '生态环境', open: '1', since: '7', sort: 'clicks', page: '3' })),
      '/feed.xml?category=%E7%94%9F%E6%80%81%E7%8E%AF%E5%A2%83&open=1&since=7',
    );
    assert.equal(subFeedHref(parseHomeQuery({ sort: 'newest' })), '/feed.xml', '排序不是条件');
  });

  it('?month= 别名在地址里折平成 from / to（同一条件只有一个规范地址）', () => {
    const alias = subFeedHref(parseHomeQuery({ month: '2026-08' }));
    assert.equal(alias, '/feed.xml?from=2026-08&to=2026-08');
    assert.equal(alias, subFeedHref(parseHomeQuery({ from: '2026-08', to: '2026-08' })));
  });

  it('lead 只跟机关一起出现；prefix 供绝对地址用（feed 内的 atom:link self）', () => {
    assert.equal(subFeedHref(parseHomeQuery({ lead: '1' })), '/feed.xml');
    assert.equal(
      subFeedHref(parseHomeQuery({ agency: '司法部', lead: '1' }), 'https://x.test'),
      'https://x.test/feed.xml?agency=%E5%8F%B8%E6%B3%95%E9%83%A8&lead=1',
    );
  });
});

describe('source 参数：按来源筛选（issue #65）', () => {
  it('source 是筛选维度（改了集合就该算），空串不算', () => {
    assert.equal(parseHomeQuery({ source: 'miit' }).source, 'miit');
    assert.equal(parseHomeQuery({ source: 'miit' }).hasFilter, true);
    assert.equal(parseHomeQuery({ source: '' }).source, undefined);
    assert.equal(parseHomeQuery({ source: '' }).hasFilter, false);
    assert.equal(parseHomeQuery({ source: ['a', 'b'] }).source, 'a', '数组取首值，与其余参数一致');
  });

  it('摘要里的来源显示名字；查不到名字时退回 ID（宁可不好读，也不能把条件从说明里省掉）', () => {
    const query = parseHomeQuery({ source: 'miit' });
    assert.equal(describeHomeQuery(query, '工业和信息化部'), '来源：工业和信息化部');
    assert.equal(describeHomeQuery(query), '来源：miit');
    assert.equal(describeHomeQuery(query, undefined), '来源：miit');
    assert.equal(
      describeHomeQuery(parseHomeQuery({ source: 'miit', open: '1' }), '工信部'),
      '来源：工信部 · 只看未截止',
    );
  });

  it('子 feed 地址带上来源条件（订的必须是同一批条目）', () => {
    assert.equal(subFeedHref(parseHomeQuery({ source: 'miit' })), '/feed.xml?source=miit');
    assert.equal(
      subFeedHref(parseHomeQuery({ source: 'miit', open: '1' })),
      '/feed.xml?source=miit&open=1',
    );
  });
});

describe('audience 参数：按受众面筛选（issue #83）', () => {
  it('三档取值都生效，且进 hasFilter（改了集合就该算）', () => {
    for (const value of ['public', 'sector', 'unknown']) {
      const query = parseHomeQuery({ audience: value });
      assert.equal(query.audience, value);
      assert.equal(query.hasFilter, true, `audience=${value} 是筛选维度`);
    }
  });

  it('未知值不生效（与领域标签同一处理：任意 querystring 不该触发无效筛选）', () => {
    for (const bad of ['', 'both', 'PUBLIC', '公众广域', 'all']) {
      const query = parseHomeQuery({ audience: bad });
      assert.equal(query.audience, undefined, `audience=${JSON.stringify(bad)} 不该生效`);
      assert.equal(query.hasFilter, false);
    }
    assert.equal(parseHomeQuery({ audience: ['sector', 'public'] }).audience, 'sector', '数组取首值');
  });

  it('口径说明里说得出是哪一档（数字站不住脚时读者要能看出是谁造成的）', () => {
    assert.equal(describeHomeQuery(parseHomeQuery({ audience: 'public' })), '受众面：公众广域');
    assert.equal(
      describeHomeQuery(parseHomeQuery({ audience: 'unknown', open: '1' })),
      '受众面：未判定 · 只看未截止',
    );
    // 与领域标签并存时顺序固定（首页那行「筛选后共 N 条（…）」与 feed 标题共用这一份）
    assert.equal(
      describeHomeQuery(parseHomeQuery({ category: '生态环境', audience: 'sector' })),
      '生态环境 · 受众面：行业专业',
    );
  });

  it('子 feed 地址带上受众面（页面筛过的条件，订阅路径上不许丢）', () => {
    assert.equal(subFeedHref(parseHomeQuery({ audience: 'sector' })), '/feed.xml?audience=sector');
    assert.equal(
      subFeedHref(parseHomeQuery({ audience: 'sector', category: '生态环境', sort: 'clicks' })),
      '/feed.xml?category=%E7%94%9F%E6%80%81%E7%8E%AF%E5%A2%83&audience=sector',
      '排序不是条件，不进地址',
    );
  });
});
