import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { IMPACT_REVIEW_STATUSES, impactReviewRecordsFrom } from '../../src/lib/impact-review.ts';
import { impactsToRender } from '../../src/lib/impact-display.ts';
import { quoteFingerprint } from '../../src/lib/summary-content.ts';

/**
 * 单元：线上量具 `deploy/audit-l3-reach.sql` 自己也要被量。
 *
 * 为什么单独开一条（issue #51/#52 收尾）：这个脚本是**门翻转那件事的唯一线上证据** ——
 * 第 5 节点名"开门那一刻会空掉的条目"、第 12 节给 #51 的两个验收数（缺口 0、错挂 0）。
 * 可它**在本机跑不了**（没有 Postgres、没有 Docker），而"跑不了的东西"在本仓有两种历史结局：
 * 要么被当成文档抄一遍就没人再看，要么悄悄漂移 —— 两种情况的表现都一样：**数字看起来是对的**。
 *
 * 所以这里量三件事，全部是**结构**上的，与"库里的数是多少"无关：
 * 1. 它自称"只读"（文件头那行承诺）—— 撤掉这个承诺的代价是在生产库上写东西；
 * 2. 它那把指纹尺子与 JS 侧 `quoteFingerprint` **同一把**（量具与页面各一把尺子的表现是
 *    "量具说能渲染、页面却不渲染"，而那种偏差在两边都看不见）；
 * 3. 它的"门放不放行"与渲染门 `impactsToRender` 的**实际行为**逐值相同（结论白名单不是抄的，
 *    是**问出来的**：对每个结论取值真的调一次门，看它放不放行）。
 *
 * **它不替代在真库上跑一遍**：这里没有 Postgres，下面的等值断言量的是"SQL 文本与 JS 尺子的
 * 意图一致"，不是 Postgres 的 regexp 引擎。真库那一遍由脚本第 12 节与
 * `scripts/review-impacts-now.mjs`（走 JS 那份判据）对读完成 —— 见 91 号文档 §9.7 运行手册。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sqlPath = path.join(repoRoot, 'deploy', 'audit-l3-reach.sql');
const sql = readFileSync(sqlPath, 'utf8');
const summaryContent = readFileSync(path.join(repoRoot, 'src', 'lib', 'summary-content.ts'), 'utf8');

/** 去掉整行注释：只读性/括号平衡这些自检不该被注释里的一句话影响。 */
const sqlCode = sql.replace(/--[^\n]*/g, '');

/**
 * 把 `pg_temp.zw_fingerprint` 的函数体**从 SQL 文本里读出来**，翻成等价的 JS 调换链。
 *
 * 关键是"读出来"而不是"再抄一份"：抄一份的实现跟 SQL 一起漂移，量的是抄件。
 * 于是任何一处改动（少一步归一、换字符集、去掉 `g`）都会让下面的等值断言当场变红。
 */
function fingerprintChainFromSql() {
  const body = /create function pg_temp\.zw_fingerprint\(t text\)[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(
    sql,
  );
  assert.ok(body, 'SQL 里应有 pg_temp.zw_fingerprint 的定义（量具那把尺子）');
  // SQL 字符串字面量里的 '' 是一个单引号；只取字面量，顺序即嵌套 regexp_replace 的求值顺序。
  const literals = [...body[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
    m[1].replace(/''/g, "'"),
  );
  // 第一个字面量是 coalesce(t, '') 的兜底值，其余按 (pattern, replacement, flags) 三连排。
  const rest = literals.slice(1);
  assert.equal(rest.length % 3, 0, `指纹链应是若干个 (pattern, replacement, flags) 三连：${rest.length}`);
  const steps = [];
  for (let index = 0; index < rest.length; index += 3) {
    steps.push({ pattern: rest[index], replacement: rest[index + 1], flags: rest[index + 2] });
  }
  assert.equal(steps.length, 4, '归一化四步：双引号字形 → 单引号字形 → 去空白 → 去包裹引号');
  for (const step of steps) {
    // 没有 g 的时候 Postgres 只换第一处，而 JS 用 .replace 配 /g —— 少了它两边立刻不同
    assert.equal(step.flags, 'g', `每一步都要带 g（否则只替换第一处）：${JSON.stringify(step)}`);
  }
  return steps.map((step) => ({
    ...step,
    // POSIX 字符类翻成 JS：脚本头注声明的口径是"ASCII 空白 + 全角空格"（见下面的残留差异那条）。
    // 注意替换的是**类里面**那一段 `[:space:]` —— 整个方括号里还有 U+3000，一起用。
    pattern: step.pattern.replace(/\[:space:\]/g, '\\t\\n\\v\\f\\r '),
  }));
}

const CHAIN = fingerprintChainFromSql();

/**
 * 取 `as renderable_impacts` 那一段子查询（从它前面最近的一个 `(select count(*)` 起）。
 *
 * 为什么不用"从头注到别名"那种写法：文件头也有一句「能不能渲染」，那一句往下会跨过
 * `base` 里的 `n.audience` —— 于是"这段里不许有受众面"会假红（实测踩过）。
 */
function renderableSubquery() {
  const end = sql.indexOf('as renderable_impacts');
  assert.ok(end > 0, 'SQL 里应有 renderable_impacts 那段子查询');
  const start = sql.lastIndexOf('(select count(*)', end);
  assert.ok(start > 0, '那一段应是一个 select count(*) 子查询');
  return sql.slice(start, end);
}

/** SQL 那把尺子的等价实现（逐步照抄上面的链，不含任何额外归一）。 */
function sqlFingerprint(text) {
  let out = text ?? '';
  for (const step of CHAIN) out = out.replace(new RegExp(step.pattern, step.flags), step.replacement);
  return out;
}

/** `normalizeQuoteMarks` 里那两个字形集合（从 JS 源码里读，不手抄）。 */
function quoteGlyphSetsFromJs() {
  const fn = /export function normalizeQuoteMarks[\s\S]*?\n\}/.exec(summaryContent);
  assert.ok(fn, 'summary-content.ts 里应有 normalizeQuoteMarks');
  const sets = [...fn[0].matchAll(/\.replace\(\/\[([^\]]+)\]\/g, (["'])(.*?)\2\)/g)].map((m) => ({
    glyphs: m[1],
    to: m[3],
  }));
  assert.equal(sets.length, 2, '两族引号：双引号族与单引号族');
  return sets;
}

/**
 * 渲染门的**实际行为**：对每个结论取值真的调一次 `impactsToRender`，看它放不放行。
 *
 * 为什么问行为而不是读字符串：白名单在 SQL 里是抄的一份，抄件对不对只有与真门比才知道。
 * 真门改了（比如"已改"不再渲染）而 SQL 没跟上，这条就红。
 */
function renderableStatusesFromGate() {
  const impact = {
    quote: '收费公路在收费偿债或者收费经营期间的管理养护费用，在车辆通行费中列支。',
    who: '',
    point: '',
    text: '期限届满后若继续收费，通行费负担可能长期化。',
    kind: 'risk',
    source: null,
    sourceUrl: null,
  };
  const renderable = [];
  for (const status of IMPACT_REVIEW_STATUSES) {
    const records = impactReviewRecordsFrom({
      impacts: [impact],
      verdicts: [
        {
          quote: impact.quote,
          text: impact.text,
          status,
          ...(status === 'revised' ? { revisedText: '审读后重写的那一句。' } : {}),
        },
      ],
      model: 'unit',
      reviewedAt: '2026-10-04T00:00:00.000Z',
    });
    assert.equal(records.length, 1, `前提：${status} 应产出一条记录（否则测的是"没记录"那条路）`);
    const rendered = impactsToRender({ impacts: [impact], reviews: records });
    if (rendered !== null) renderable.push(status);
  }
  return renderable;
}

describe('audit-l3-reach.sql：结构与"只读"这句承诺', () => {
  it('除会话级临时视图与一个 pg_temp 函数外没有任何写动作', () => {
    const writes = [...sqlCode.matchAll(/^\s*(create|insert|update|delete|drop|alter|truncate|grant)\b[^\n;]*/gim)];
    assert.ok(writes.length > 0, '至少应能认出那几个 create');
    for (const write of writes) {
      const statement = write[0].trim().toLowerCase();
      assert.ok(
        statement.startsWith('create temp view') || statement.startsWith('create function pg_temp.'),
        `只允许 create temp view / create function pg_temp.，出现了：${statement}`,
      );
    }
    // 逐个关键词再扫一遍：上面那条只看得见行首，写在行中的写动作也得拦住
    assert.ok(
      !/\b(insert\s+into|delete\s+from|truncate|alter\s+table|grant\s|revoke\s)\b/i.test(sqlCode),
      '只读脚本里不该出现 insert / delete / truncate / alter table / grant',
    );
    assert.ok(
      !/\bupdate\s+[a-z_]+\s+set\b/i.test(sqlCode),
      '只读脚本里不该出现 update ... set',
    );
  });

  it('$$ 成对、括号平衡（改坏了在真库上是"语法错误"而不是"数字不对"）', () => {
    assert.equal(sql.split('$$').length % 2, 1, '$$ 必须成对');
    const open = (sqlCode.match(/\(/g) ?? []).length;
    const close = (sqlCode.match(/\)/g) ?? []).length;
    assert.equal(open, close, `括号应平衡，实际 ( ${open} / ) ${close}`);
  });

  it('#51/#52 的四节与两个验收数都在（删一节就等于删了验收口径）', () => {
    for (const header of ['=== 5.', '=== 6.', '=== 9c.', '=== 12.']) {
      assert.ok(sql.includes(header), `缺少小节 ${header}`);
    }
    // 第 12 节那两个数就是 #51 的验收判据：缺口必须 0、错挂必须 0
    assert.ok(sql.includes('缺口条目(门不放行)'), '第 12 节要数"有判读但门不放行"的条目');
    assert.ok(sql.includes('错挂记录数(必须0)'), '第 12 节要数错挂的记录（必须为 0）');
    assert.ok(sql.includes('review-impacts-now.mjs'), '第 5 节要指出补记录用哪个工具');
  });

  it('用到的两个新列在 postgres schema 与迁移里都真的存在（脚本不该引用不存在的列）', () => {
    const postgresSchema = readFileSync(path.join(repoRoot, 'src', 'db', 'schema', 'postgres.ts'), 'utf8');
    for (const column of ['impact_review_json', 'summary_diagnostics_json']) {
      assert.ok(sql.includes(column), `脚本应引用 ${column}`);
      assert.ok(postgresSchema.includes(column), `postgres schema 里应有 ${column}`);
    }
    const migration = readFileSync(
      path.join(repoRoot, 'drizzle', 'postgres', '0020_add_impact_reviews.sql'),
      'utf8',
    );
    assert.ok(migration.includes('impact_review_json'), '迁移 0020 应加上 impact_review_json');
  });
});

describe('audit-l3-reach.sql：量具的尺子与 JS 侧同一把', () => {
  it('四步归一照 SQL 文本逐字翻过来之后，与 quoteFingerprint 逐例全等', () => {
    const cases = [
      '“公路法（修正草案征求意见稿）”',
      '「公路法（修正草案征求意见稿）」',
      '"公路法（修正草案征求意见稿）"',
      '收费公路在收费偿债期间的管理养护费用，\n    在车辆通行费中列支。',
      '　收费公路　在收费偿债期间的管理养护费用\t在车辆通行费中列支。 ',
      '  “第二条修改为：从事前款活动应当取得许可。”  ',
      "'单引号族不跟双引号族互等'",
      '收费公路在收费偿债或者收费经营期间的管理养护费用，在车辆通行费中列支。',
      '',
    ];
    for (const text of cases) {
      assert.equal(
        sqlFingerprint(text),
        quoteFingerprint(text),
        `同一段文字两把尺子必须量出同一个指纹：${JSON.stringify(text)}`,
      );
    }
    // 方向也要一条：单双引号**不**互等（混着归一会造出假命中）。
    // 注意别拿"被引号包起来"的短句当例子 —— 那两族都会被最后一步"去包裹引号"抹平，
    // 测出来的是那一步而不是这一条。
    assert.notEqual(sqlFingerprint('甲“乙”丙'), sqlFingerprint("甲'乙'丙"), '两族引号不许互相归一');
  });

  it('引号字形集合直接从 JS 源码读出来比对（加一个字形只改一边就会红）', () => {
    const sets = quoteGlyphSetsFromJs();
    const [doubleStep, singleStep] = CHAIN;
    assert.equal(
      doubleStep.pattern,
      `[${sets[0].glyphs}]`,
      '双引号族的字形集合要与 normalizeQuoteMarks 一模一样',
    );
    assert.equal(doubleStep.replacement, sets[0].to);
    assert.equal(singleStep.pattern, `[${sets[1].glyphs}]`, '单引号族同理');
    assert.equal(singleStep.replacement, sets[1].to);
  });

  it('空白那一步按脚本头注声明的口径（ASCII 空白 + 全角空格）', () => {
    assert.match(CHAIN[2].pattern, /\[\\t\\n\\v\\f\\r 　\]\+/, '空白步：ASCII 空白 + 全角空格（U+3000）');
    assert.ok(/\[\\s\\u3000\]\+/.test(summaryContent), 'JS 侧是 \\s + \\u3000');
  });

  it('已知残留差异：NBSP 只有 JS 那把尺子会去掉（真库那一遍要核对，别让它变成惊喜）', () => {
    // 脚本头注写明：JS 的 \s 覆盖 NBSP 等 Unicode 空白，而 SQL 那层只列了 ASCII 空白与全角空格。
    // 本机没有 Postgres，这条量的是"按脚本自己声明的口径"，不是真库行为；真库若在 UTF-8 locale 下
    // 让 [[:space:]] 覆盖了 NBSP，两边就一致 —— 这正是 §9.7 要拿两个工具对读一遍的理由。
    const withNbsp = '甲\u00a0乙';
    assert.equal(quoteFingerprint(withNbsp), '甲乙');
    assert.equal(
      sqlFingerprint(withNbsp),
      withNbsp,
      '若哪天给 zw_fingerprint 补上了 \\u00A0，请把这条断言改成相等，并删掉 SQL 头注里的残留差异说明',
    );
  });
});

describe('audit-l3-reach.sql：门放不放行与渲染门同一份判据', () => {
  it('结论白名单不是抄的：与 impactsToRender 的实际行为逐值相同', () => {
    const renderable = renderableStatusesFromGate().sort();
    const listMatch = /coalesce\(rec ->> 'status', ''\) in \(([^)]*)\)/.exec(renderableSubquery());
    assert.ok(listMatch, 'SQL 里应有一份结论白名单');
    const fromSql = [...listMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(fromSql, renderable, `SQL 白名单 ${fromSql} 应与门的行为 ${renderable} 相同`);
    assert.deepEqual(renderable, ['passed', 'revised'], '门放行的是"通过"与"已改"两种结论');
  });

  it('两个指纹都要全等（少比一个 = 生成侧重跑后旧结论照旧生效）', () => {
    const subquery = renderableSubquery();
    assert.ok(
      subquery.includes("rec ->> 'quoteFingerprint' = pg_temp.zw_fingerprint(i ->> 'quote')"),
      '要比 quote 指纹',
    );
    assert.ok(
      subquery.includes("rec ->> 'textFingerprint' = pg_temp.zw_fingerprint(i ->> 'text')"),
      '要比 text 指纹（只比一个就是"重跑后旧结论照旧生效"）',
    );
    assert.equal(
      (sql.match(/rec ->> 'textFingerprint' = pg_temp\.zw_fingerprint\(i ->> 'text'\)/g) ?? []).length,
      2,
      '门放行与"被剔除"两段都要比 text 指纹',
    );
  });

  it('"能不能渲染"里不许再出现受众面（#52：受众面已退出判据）', () => {
    assert.ok(
      !/audience/.test(renderableSubquery()),
      '受众面一旦回到这一段，量具与页面就又各说各话了',
    );
    assert.ok(
      /when renderable_impacts > 0 then 'ok\.真的渲染得出来'/.test(sql),
      '分档要按 renderable_impacts 判"放行"，不是按受众面',
    );
  });

  it('分档仍是互斥的一个 case 表达式（各档之和 > 总数那种错看不出来）', () => {
    const bucket = /case\s+when s is null then 'z\.没有摘要'[\s\S]*?end as bucket/.exec(sql);
    assert.ok(bucket, '应有一个 case 表达式定义分档');
    assert.ok(
      !/count\(\*\) filter \(where bucket/.test(bucket[0]),
      '分档内部不许再套 filter 统计（那会让各档重叠）',
    );
    assert.ok(sql.includes('差额(必须是0)'), '第 3 节要带一条"分档合计 = 总数"的自检');
  });
});
