import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickDueStage } from '../../worker/jobs/send-deadline-reminders.ts';
import {
  MAX_REMINDER_ITEMS_PER_EMAIL,
  buildReminderDigestEmail,
  buildReminderEmail,
} from '../../src/lib/mail.ts';

/**
 * 单元：截止提醒的选档与措辞（issue #60 第一刀）。
 *
 * 旧规则是 `剩余天数 === 7 || === 3` 的精确相等，而调度每日一轮 —— 那一天只要任务没跑成
 * （发布窗口错开、容器重启、源站把整轮拖垮），条目就从「剩 8 天」跳到「剩 6 天」，
 * 7 天档**永远不会再命中**：用户少收一封提醒，日志上没有任何异常。
 * 改成「已到该档且该档未发过」后，漏掉的那一档下一轮补发，去重键仍保证每档至多一封。
 *
 * 窗口化会新引入一个坑，也在这里一并钉住：库列 `status` 是抓取口径的缓存（issue #43），
 * 已过期但还没被下一轮抓取改口的条目仍是 `open` —— 按窗口判定就会给已过截止的条目发提醒。
 */

/** 造一个「这些档已发过」的判定函数。 */
const sentOf = (sentStages) => async (stage) => sentStages.includes(stage);

describe('pickDueStage：按窗口 + 已发标记选档', () => {
  it('还没到任何一档 ⇒ 不发，且不算「已发过所以跳过」', async () => {
    const picked = await pickDueStage(8, sentOf([]));
    assert.equal(picked.stage, undefined, '剩 8 天不该发');
    assert.equal(picked.allSent, false, '跳过是因为没到档，不是因为都发过（日志要能分清）');
  });

  it('按点到：剩 7 天发 7 天档，剩 3 天发 3 天档', async () => {
    assert.equal((await pickDueStage(7, sentOf([]))).stage?.stage, 'd7');
    assert.equal((await pickDueStage(3, sentOf(['d7']))).stage?.stage, 'd3');
  });

  it('漏跑的那天下一轮补发 —— 这正是旧规则永久丢档的那一格', async () => {
    const picked = await pickDueStage(6, sentOf([]));
    assert.equal(picked.stage?.stage, 'd7', '旧规则在这里什么都不发，7 天档就此消失');
  });

  it('每轮每人每条至多一封：两档都没发而只剩 2 天时，先发更靠前的那档', async () => {
    const picked = await pickDueStage(2, sentOf([]));
    assert.equal(picked.stage?.stage, 'd7');
  });

  it('已发过的档不重发；没到点的档不会被提前催', async () => {
    const settled = await pickDueStage(6, sentOf(['d7']));
    assert.equal(settled.stage, undefined, 'd7 已发、d3 还没到 ⇒ 本轮什么都不发');
    assert.equal(settled.allSent, true, '这条跳过是幂等，不是漏发');
  });

  it('今天截止仍发一封（这是最有用的那封）', async () => {
    assert.equal((await pickDueStage(0, sentOf(['d7']))).stage?.stage, 'd3');
  });

  it('已过截止一封都不发（库列可能还写着 open）', async () => {
    const picked = await pickDueStage(-1, sentOf([]));
    assert.equal(picked.stage, undefined);
    assert.equal(picked.allSent, false, '过期不等于"已发过"，两个口径不能混');
  });
});

describe('提醒邮件的档位措辞与实际剩余一致', () => {
  const notice = {
    id: 'f'.repeat(32),
    title: '关于某办法公开征求意见的公告',
    deadlineAt: '2026-10-05',
    url: 'https://source.test/notice.html',
  };

  /** 截止日期那一行（文案都在这一行上，断言就不必去猜别的行）。 */
  const deadlineLineOf = (text) => text.split('\n').find((line) => line.startsWith('截止日期：'));

  it('按点发出时只写事实：哪一天截止、还剩几天，不提补发', () => {
    const mail = buildReminderEmail({
      email: 'reader@example.test',
      notice,
      days: 7,
      stage: 'd7',
      unsubscribeToken: 'tok',
    });
    assert.match(mail.subject, /剩 7 天/);
    assert.equal(deadlineLineOf(mail.text), '截止日期：2026-10-05（还剩 7 天）');
    assert.ok(
      !mail.text.includes('这次是补发'),
      '没晚就不该把这一封标成补发（政策说明里那句"漏跑会补发"不算）',
    );
  });

  it('补发时明写「补发」与实际剩余天数（不能一边剩 5 天一边自称"截止前 7 天提醒"）', () => {
    const mail = buildReminderEmail({
      email: 'reader@example.test',
      notice,
      days: 5,
      stage: 'd7',
      unsubscribeToken: 'tok',
    });
    assert.match(mail.subject, /剩 5 天/, '主题按实际剩余写');
    // 补发这件事**不许把括号套起来**：原文案是
    // 「（还剩 0 天，截止前 7 天档补发（原定提前 7 天，实际剩 0 天））」
    assert.equal(
      deadlineLineOf(mail.text),
      '截止日期：2026-10-05（还剩 5 天；本档原定在截止前 7 天发出，这次是补发）',
    );
    assert.match(mail.html, /这次是补发/, 'HTML 版同样标注');
  });

  it('今天截止不许写成「还剩 0 天」（这是还能提意见的最后一天）', () => {
    const mail = buildReminderEmail({
      email: 'reader@example.test',
      notice,
      days: 0,
      stage: 'd3',
      unsubscribeToken: 'tok',
    });
    assert.equal(deadlineLineOf(mail.text), '截止日期：2026-10-05（今天截止；本档原定在截止前 3 天发出，这次是补发）');
    assert.doesNotMatch(mail.text, /还剩 0 天/);
    assert.doesNotMatch(mail.html, /还剩 0 天/);
    assert.match(mail.subject, /今天截止/);
  });

  it('截止日期那一行只有一层括号（双层括号读起来要读者自己配对）', () => {
    for (const days of [7, 5, 0]) {
      const mail = buildReminderEmail({
        email: 'reader@example.test',
        notice,
        days,
        stage: 'd7',
        unsubscribeToken: 'tok',
      });
      const line = deadlineLineOf(mail.text);
      assert.equal((line.match(/（/g) ?? []).length, 1, `剩 ${days} 天的截止日期行：${line}`);
      assert.equal((line.match(/）/g) ?? []).length, 1, `剩 ${days} 天的截止日期行：${line}`);
    }
  });

  it('标题只出现一次，且不在标题后硬拼「征求意见」（issue #79：全库恰好 5 条标题自带这个词）', () => {
    const mail = buildReminderEmail({
      email: 'reader@example.test',
      notice: { ...notice, title: '住房城乡建设部关于《某某标准》公开征求意见的通知' },
      days: 3,
      stage: 'd3',
      unsubscribeToken: 'tok',
    });
    // 第一行是标题唯一出现的地方；旧文案第一行拼了「征求意见即将截止」，
    // 第二行又原样重复一次标题 —— 念出来是「…征求意见征求意见即将截止」
    const occurrences = mail.text.split('公开征求意见的通知').length - 1;
    assert.equal(occurrences, 1, `标题应只出现一次，实际 ${occurrences} 次：\n${mail.text}`);
    assert.ok(!mail.text.includes('征求意见征求意见'), '不许把标题自带的「征求意见」再拼一遍');
    assert.ok(!mail.text.includes('标题：'), '第二行那次重复已经取消');
    assert.match(mail.text.split('\n')[0], /^你订阅的公示「.+」即将截止：$/);
  });

  it('订阅侧承诺改成可兑现的说法：漏跑的那天下一轮补一次，且不会重复发', () => {
    const mail = buildReminderEmail({
      email: 'reader@example.test',
      notice,
      days: 3,
      stage: 'd3',
      unsubscribeToken: 'tok',
    });
    assert.match(mail.text, /下一轮补发一次（不会重复发）/);
    assert.match(mail.html, /下一轮补发一次（不会重复发）/);
  });
});

/**
 * 合并提醒（issue #84）：**一位订阅者一轮至多一封**。
 *
 * 旧行为"一条公示一封"在生产上真的发生过：2026-09-25 那一轮同一个人收到 6 封，
 * 站长随后退订（原话"订阅信息有点多"）。这个模板补的就是这个缺口，所以这一组
 * 钉的是合并之后**不能丢信息**：每条都要有自己的截止日期、剩余天数、站内详情与
 * 官方原文链接 —— 合并成"一封里只写标题"就不是减量而是减信息了。
 */
describe('issue #84：多条到档时合并成一封', () => {
  const noticeOf = (id, title, deadlineAt) => ({
    id,
    title,
    deadlineAt,
    url: `https://source.test/${id}.html`,
  });

  const digestOf = (items, overflowCount = 0) =>
    buildReminderDigestEmail({
      email: 'reader@example.test',
      items,
      overflowCount,
      unsubscribeToken: 'tok',
    });

  it('主题说清条数与最近的一条，正文按剩余天数从少到多排（最急的排最前）', () => {
    const mail = digestOf([
      { notice: noticeOf('a'.repeat(16), '甲标准征求意见', '2026-10-05'), days: 7, stage: 'd7' },
      { notice: noticeOf('b'.repeat(16), '乙条例征求意见', '2026-10-01'), days: 3, stage: 'd3' },
    ]);
    assert.match(mail.subject, /2 条公示即将截止/);
    assert.match(mail.subject, /最近一条还剩 3 天/);
    assert.ok(
      mail.text.indexOf('乙条例征求意见') < mail.text.indexOf('甲标准征求意见'),
      `最急的应排最前：\n${mail.text}`,
    );
    assert.match(mail.text, /按剩余天数从少到多排列/);
  });

  it('每条都带自己的截止日期、剩余天数、站内详情与官方原文链接（合并 ≠ 减信息）', () => {
    const mail = digestOf([
      { notice: noticeOf('a'.repeat(16), '甲标准征求意见', '2026-10-05'), days: 7, stage: 'd7' },
      { notice: noticeOf('b'.repeat(16), '乙条例征求意见', '2026-10-01'), days: 3, stage: 'd3' },
    ]);
    for (const [id, title, deadline, days] of [
      ['a'.repeat(16), '甲标准征求意见', '2026-10-05', 7],
      ['b'.repeat(16), '乙条例征求意见', '2026-10-01', 3],
    ]) {
      assert.ok(mail.text.includes(title), `缺「${title}」`);
      assert.ok(
        mail.text.includes(`截止日期：${deadline}（还剩 ${days} 天）`),
        `每天都该有自己的剩余天数：${mail.text}`,
      );
      assert.ok(mail.text.includes(`/notices/${id}`), `每条都要有站内详情链接（${title}）`);
      assert.ok(mail.text.includes(`https://source.test/${id}.html`), `每条都要有官方原文链接（${title}）`);
    }
    assert.ok(mail.text.includes('unsubscribe?token='), '合并之后退订链接照样在');
    assert.match(mail.text, /同一轮里若有多条同时到档，会合并成一封发出/);
  });

  it('补发仍逐条标注（剩 5 天的那条自称"原定 7 天档"就是说谎）', () => {
    const mail = digestOf([
      { notice: noticeOf('a'.repeat(16), '甲标准征求意见', '2026-10-05'), days: 5, stage: 'd7' },
      { notice: noticeOf('b'.repeat(16), '乙条例征求意见', '2026-10-03'), days: 3, stage: 'd3' },
    ]);
    assert.match(mail.text, /还剩 5 天；本档原定在截止前 7 天发出，这次是补发/);
    assert.ok(
      !/还剩 3 天；本档原定/.test(mail.text),
      '按点发出的那条不该被标成补发（档位标注逐条判，不能整封信共用一个）',
    );
  });

  it('超出上限只列前 N 条并如实报数，没列进去的下一轮还会来', () => {
    const items = Array.from({ length: MAX_REMINDER_ITEMS_PER_EMAIL + 3 }, (_v, i) => ({
      notice: noticeOf(String(i).padStart(16, '0'), `批量条目 ${i}`, '2026-10-05'),
      days: 3 + i,
      stage: 'd3',
    }));
    const listed = items.slice(0, MAX_REMINDER_ITEMS_PER_EMAIL);
    const mail = digestOf(listed, items.length - listed.length);
    assert.match(mail.subject, new RegExp(`${MAX_REMINDER_ITEMS_PER_EMAIL} 条公示即将截止`));
    assert.equal((mail.text.match(/^· /gm) ?? []).length, MAX_REMINDER_ITEMS_PER_EMAIL);
    assert.match(mail.text, /另有 3 条本轮未列入/);
    assert.match(mail.text, /会在下一封里发出/);
  });

  it('标题里的 HTML 与 href 里的引号都转义（源站数据不可信，与单条版同一条规矩）', () => {
    const mail = digestOf([
      {
        notice: {
          ...noticeOf('a'.repeat(16), '关于《A&B条例（<试行>）》征求意见', '2026-10-05'),
          url: 'https://source.test/a"onmouseover="alert(1)',
        },
        days: 7,
        stage: 'd7',
      },
      { notice: noticeOf('b'.repeat(16), '乙条例征求意见', '2026-10-01'), days: 3, stage: 'd3' },
    ]);
    assert.ok(!mail.html.includes('<试行>'), '标题里的尖括号不应成为标签');
    assert.match(mail.html, /A&amp;B条例（&lt;试行&gt;）/);
    assert.ok(!mail.html.includes('onmouseover="alert(1)"'), `href 里的引号不应逃出属性：${mail.html}`);
    assert.match(mail.text, /A&B条例（<试行>）/, '纯文本保持字面');
  });
});
