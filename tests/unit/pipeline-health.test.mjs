import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BACKUP_MAX_AGE_HOURS,
  backupFreshness,
  crawlFreshness,
  indexHealth,
  mailLoop,
  overallVerdict,
  probeOf,
  readerActivity,
  summaryBacklog,
} from '../../src/lib/pipeline-health.ts';

/**
 * 单元（issue #74）：管线健康清单的判据。
 *
 * 这一组断言要钉的不是"算得对"，而是三件容易在下次改动里被悄悄放弃的事：
 * 1. **探针没看到 ≠ 没问题**（#68 的根因就是拿 `crontab -l` 与 unit active 当验收）；
 * 2. 需求侧事实（0 个可发订阅者、0 次点击）判 warn 而不是 fail —— 判成 fail 会让人去修
 *    一条本来正常的路径，判成 ok 又会让"闭环其实没人能收到"继续隐身；
 * 3. 总结论的优先级：有 fail 就不能被一堆 ok 平均掉。
 */

describe('issue #74：备份产物判据', () => {
  it('没挂载备份目录 ⇒ unknown，不判健康', () => {
    const check = backupFreshness({ seenDir: false, newestAgeHours: 0.1 });
    assert.equal(check.verdict, 'unknown');
    assert.match(check.detail, /不判健康/);
  });

  it('挂载了但一个 dump 都没有 ⇒ fail（从没成功备份过）', () => {
    assert.equal(backupFreshness({ seenDir: true, newestAgeHours: null }).verdict, 'fail');
  });

  it('新鲜度按阈值两侧各判一次', () => {
    assert.equal(backupFreshness({ seenDir: true, newestAgeHours: 1.3 }).verdict, 'ok');
    assert.equal(
      backupFreshness({ seenDir: true, newestAgeHours: BACKUP_MAX_AGE_HOURS + 0.1 }).verdict,
      'fail',
      '刚过阈值就该翻红，留余量是 cron 自己那一层的事',
    );
  });
});

describe('issue #74：其余各面的判据', () => {
  it('没有任何 first_seen_at ⇒ 抓取新鲜度 unknown（存量不回填是有意为之）', () => {
    assert.equal(crawlFreshness(null).verdict, 'unknown');
    assert.equal(crawlFreshness(15.3).verdict, 'ok');
    assert.equal(crawlFreshness(49).verdict, 'warn');
  });

  it('抽样 0 条时不许报 ok（那等于"没测"被当成"通过"）', () => {
    assert.equal(indexHealth(0, 0).verdict, 'unknown');
    assert.equal(indexHealth(12, 0).verdict, 'ok');
    assert.equal(indexHealth(12, 3).verdict, 'fail');
  });

  it('可发订阅者 0 是 warn 并写清"不是故障"', () => {
    const check = mailLoop(0, 0);
    assert.equal(check.verdict, 'warn');
    assert.match(check.detail, /需求侧事实不是故障/);
    assert.equal(mailLoop(2, 5).verdict, 'ok');
    assert.equal(mailLoop(2, 0).verdict, 'warn', '有人可发却一封没发出去 ⇒ 这才要查路径');
  });

  it('近 7 天 0 次点击判 warn 不判 fail', () => {
    assert.equal(readerActivity(0).verdict, 'warn');
    assert.equal(readerActivity(113).verdict, 'ok');
    assert.equal(summaryBacklog(0).verdict, 'ok');
    assert.equal(summaryBacklog(120).verdict, 'warn');
  });

  it('总结论：fail 优先，unknown 与 warn 都不许被 ok 平均掉', () => {
    const wrap = (verdict) => ({ name: 'x', verdict, detail: '' });
    assert.equal(overallVerdict([wrap('ok'), wrap('fail'), wrap('unknown')]), 'fail');
    assert.equal(overallVerdict([wrap('ok'), wrap('unknown')]), 'warn');
    assert.equal(overallVerdict([wrap('ok'), wrap('ok')]), 'ok');
  });

  it('抽样查询词优先取书名号内的名称（共有词测不出漂移）', () => {
    assert.equal(probeOf('关于公开征求《水体沉积物质量技术规范（征求意见稿）》的通知'), '水体沉积物质量技术规范（征求意见稿）');
    assert.equal(probeOf('没有书名号的一个很长的标题字符串而已'), '没有书名号的一个很长');  // slice(0, 10) 十个字
  });
});
