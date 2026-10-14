import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { countdownDays, countdownText, countdownView } from '../../src/lib/notice-countdown.ts';
import { effectiveStatus } from '../../src/lib/notice-status.ts';

/**
 * 单元：倒计时的展示判据与紧迫度分档（2026-10-07）。
 *
 * 判据住在 `src/lib/notice-countdown.ts`（纯函数，可被本文件真 import）——这是本仓库
 * 的一贯口径：**判据抽 `.ts`、页面只做摆放**。`.tsx` 里的分支进不了单测（单测是
 * `node --test` 直跑 `.ts`/`.mjs`，Node 的类型剥离不吃 `.tsx`，实测
 * `ERR_UNKNOWN_FILE_EXTENSION`），而 e2e 跑的是 `.next` 构建产物。所以这一组是
 * **真值表**（不是源码文本断言）：两层边界的行为在这里被逐个钉住。
 *
 * 两条被这一刀钉住的缺陷：
 *
 * 1. **同一张卡片上两个状态口径**：倒计时此前判 `notice.status !== 'open'`（**库列快照**），
 *    而同一行的徽标判 `effectiveStatus()`（展示层复核，issue #43）。状态列是抓取时推导的、
 *    抓取每日一轮：每天 00:00 到下一轮之间（生产实测约 14 小时）同一条卡片上会出现
 *    「徽标已经说已截止、倒计时还在」。所以这里有一条把两个判据**放在同一输入下**的断言。
 * 2. **紧迫度只有一档**：醒目样式此前只在「今天截止 / 明天截止」触发，判据还是**文案字符串**
 *    （`text === '今天截止' || text === '明天截止'`）—— 于是「剩 2 天」「剩 3 天」与
 *    「剩 30 天」长得一模一样，最该催人的那一档反而不醒目；而文案改一个字就会把分档改坏。
 *    现在按**天数**分两档，文案一个字都没改。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const NOW = new Date('2026-09-21T06:00:00Z'); // 北京 2026-09-21 14:00

/** 只喂倒计时读得到的字段（status / deadlineAt）。 */
function notice(status, deadlineAt) {
  return { status, deadlineAt };
}

/** 相对 NOW 第 n 天（北京时间）的 ISO 日期 —— 用日历日算，绕开时区与夏令时。 */
function deadlineAfter(days) {
  return new Date(Date.UTC(2026, 8, 21) + days * 86_400_000).toISOString().slice(0, 10);
}

describe('倒计时分档：两层边界（0–1 / 2–3 / ≥4）', () => {
  it('0–1 天是最强档：今天截止 / 明天截止', () => {
    assert.deepEqual(countdownView(notice('open', deadlineAfter(0)), NOW), {
      text: '今天截止',
      className: 'countdown countdown-urgent',
    });
    assert.deepEqual(countdownView(notice('open', deadlineAfter(1)), NOW), {
      text: '明天截止',
      className: 'countdown countdown-urgent',
    });
  });

  it('2–3 天是中间档（改动前它们与「剩 30 天」长得一模一样）', () => {
    assert.deepEqual(countdownView(notice('open', deadlineAfter(2)), NOW), {
      text: '剩 2 天',
      className: 'countdown countdown-soon',
    });
    assert.deepEqual(countdownView(notice('open', deadlineAfter(3)), NOW), {
      text: '剩 3 天',
      className: 'countdown countdown-soon',
    });
  });

  it('≥4 天不醒目：只剩基础类，文案仍是「剩 N 天」', () => {
    assert.deepEqual(countdownView(notice('open', deadlineAfter(4)), NOW), {
      text: '剩 4 天',
      className: 'countdown',
    });
    assert.deepEqual(countdownView(notice('open', deadlineAfter(30)), NOW), {
      text: '剩 30 天',
      className: 'countdown',
    });
  });

  it('分档判据是**天数**不是文案：改文案不会把档位一起改掉', () => {
    // 中间档的文案必须逐字是改动前那句（既有 e2e 锚在「剩 N 天」上），
    // 而档位来自天数：这里同时钉住"文案没变"与"档位确实变了"。
    assert.equal(countdownText(notice('open', deadlineAfter(2)), NOW), '剩 2 天');
    assert.equal(countdownText(notice('open', deadlineAfter(3)), NOW), '剩 3 天');
    assert.equal(
      countdownView(notice('open', deadlineAfter(3)), NOW)?.className,
      'countdown countdown-soon',
    );
  });
});

describe('倒计时的展示判据与状态徽标同口径（库列快照 vs 展示层复核）', () => {
  it('库内 open、截止日已过 → 两边同时改口（那 14 小时窗口）', () => {
    const expired = notice('open', deadlineAfter(-1));
    assert.equal(effectiveStatus(expired, NOW), 'closed', '徽标必须改口');
    assert.equal(countdownDays(expired, NOW), null, '倒计时必须同时消失');
    assert.equal(countdownView(expired, NOW), null);
  });

  it('截止日就是今天 → 两边都还在（截止当天可以提意见）', () => {
    const today = notice('open', deadlineAfter(0));
    assert.equal(effectiveStatus(today, NOW), 'open');
    assert.equal(countdownDays(today, NOW), 0);
  });

  it('closed / resulted 一律不展示倒计时（以库内为准，与徽标同一判据）', () => {
    for (const status of ['closed', 'resulted']) {
      // 截止日在未来也一样：源站说结束了就是结束了
      const record = notice(status, deadlineAfter(30));
      assert.equal(effectiveStatus(record, NOW), status);
      assert.equal(countdownDays(record, NOW), null, status);
      assert.equal(countdownView(record, NOW), null, status);
    }
  });

  it('拿不到截止日期 / 坏值 → 不展示（推不出天数就不编一个）', () => {
    for (const deadline of [null, undefined, '待定', '2026-13-45']) {
      assert.equal(countdownDays(notice('open', deadline), NOW), null, String(deadline));
      assert.equal(countdownText(notice('open', deadline), NOW), null, String(deadline));
      assert.equal(countdownView(notice('open', deadline), NOW), null, String(deadline));
    }
  });

  it('边界按北京日历日切（与 daysUntil / effectiveStatus 同一口径）', () => {
    // 北京 09-21 00:30 = UTC 09-20 16:30 → 截止 09-21 的条目此刻是「今天截止」
    assert.equal(
      countdownText(notice('open', '2026-09-21'), new Date('2026-09-20T16:30:00Z')),
      '今天截止',
    );
    // 北京 09-20 23:59 还没到 09-21
    assert.equal(
      countdownText(notice('open', '2026-09-21'), new Date('2026-09-20T15:59:00Z')),
      '明天截止',
    );
  });
});

describe('组件接线与样式：分档真的挂到了 DOM 上', () => {
  const displaySource = readFileSync(
    path.join(repoRoot, 'src/app/_lib/notice-display.tsx'),
    'utf8',
  );
  const css = readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8');

  it('Countdown 用的是 countdownView 给的类名（判据写对了却没接上，是这类改动最常见的断线）', () => {
    assert.match(
      displaySource,
      /import \{ countdownView \} from '@\/lib\/notice-countdown';/,
      '判据必须从 lib 引进来',
    );
    assert.match(
      displaySource,
      /const view = countdownView\(notice, now\);/,
      '组件必须走 countdownView —— 自己再拼一次类名就是第二份判据',
    );
    assert.match(
      displaySource,
      /<span className=\{view\.className\} data-testid="notice-countdown">/,
      '类名必须落在那个 span 上（e2e 正是按 data-testid="notice-countdown" 取文案的）',
    );
  });

  it('倒计时不再各判一份状态：页面侧源码里不许再出现与 notice.status 的比较', () => {
    assert.doesNotMatch(
      displaySource,
      /notice\.status\s*[!=]==?\s*'open'/,
      '「要不要展示倒计时」必须与徽标同一条判据（effectiveStatus），不许各写一份',
    );
  });

  it('中间档在 globals.css 里有规则，且与最强档看得出差别', () => {
    const soonRule = /\.countdown-soon \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const urgentRule = /\.countdown-urgent \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    assert.ok(soonRule.length > 0, '中间档必须有规则（无规则 = 落回基础档、静默失效）');
    assert.ok(urgentRule.length > 0, '最强档的规则仍要在（那一档没动）');
    assert.notEqual(soonRule.trim(), urgentRule.trim(), '两档同值就等于又回到只有一档');
    assert.match(urgentRule, /font-weight:\s*600/, '最强档保持原有的加粗');
    assert.doesNotMatch(soonRule, /font-weight/, '中间档不加粗（明显但不刺眼）');
  });
});
