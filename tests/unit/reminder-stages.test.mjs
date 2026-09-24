import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickDueStage } from '../../worker/jobs/send-deadline-reminders.ts';
import { buildReminderEmail } from '../../src/lib/mail.ts';

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

  it('按点发出时只标档位，不提补发', () => {
    const mail = buildReminderEmail({
      email: 'reader@example.test',
      notice,
      days: 7,
      stage: 'd7',
      unsubscribeToken: 'tok',
    });
    assert.match(mail.subject, /剩 7 天/);
    assert.match(mail.text, /还剩 7 天，截止前 7 天档）/);
    assert.ok(!mail.text.includes('档补发'), '没晚就不该把这一封标成补发（政策说明里那句"漏跑会补发"不算）');
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
    assert.match(mail.text, /截止前 7 天档补发（原定提前 7 天，实际剩 5 天）/);
    assert.match(mail.html, /补发/, 'HTML 版同样标注');
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
