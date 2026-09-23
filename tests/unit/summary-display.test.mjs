import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  SUMMARY_NOT_SUMMARIZED_STATUS,
  summaryDisplayState,
} from '../../src/lib/summary-display.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoFile = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * 单元：摘要区的显示态（issue #58）。
 *
 * 起因是线上实测：库里 108 条已截止条目被写成「摘要生成中」，而摘要任务的入队条件
 * 按 issue #4 的设计**排除已截止条目** —— 那句「生成中」永远不会兑现。修它靠的不是
 * 在页面里再加一个 if，而是把「这一条到底会不会被生成」写成一处能测的判定。
 *
 * 这里最值得钉的是**优先级**：五分支各自单看都对，出错的方式是顺序不对 ——
 * 比如「已截止」判在「已有摘要」之前，就会把库里已有的摘要藏起来。
 */

const BASE = {
  hasSummary: false,
  summaryStatus: 'pending',
  noticeStatus: 'open',
  llmReady: true,
};

describe('summaryDisplayState：五分支与优先级', () => {
  it('库里已有摘要 → 一律渲染摘要本体，哪怕条目已截止', () => {
    assert.equal(
      summaryDisplayState({ ...BASE, hasSummary: true, noticeStatus: SUMMARY_NOT_SUMMARIZED_STATUS }),
      'view',
      '已截止但已生成过摘要的条目必须照常显示（本次修改绝不能误伤它）',
    );
    assert.equal(
      summaryDisplayState({
        ...BASE,
        hasSummary: true,
        summaryStatus: 'failed_review',
        llmReady: false,
      }),
      'view',
      '有摘要就不该被任何占位态盖掉：绝不隐藏库里已有的内容',
    );
  });

  it('端口不可用 → 「暂未启用」，且优先于截止与复核', () => {
    assert.equal(summaryDisplayState({ ...BASE, llmReady: false }), 'unavailable');
    assert.equal(
      summaryDisplayState({ ...BASE, llmReady: false, noticeStatus: 'closed' }),
      'unavailable',
      'LLM 没配时说什么「不会补生成」都没意义，先说未启用（issue #22 的门控语义不变）',
    );
    assert.equal(
      summaryDisplayState({ ...BASE, llmReady: false, summaryStatus: 'failed_review' }),
      'unavailable',
    );
  });

  it('待人工复核优先于「已截止所以不生成」', () => {
    assert.equal(
      summaryDisplayState({ ...BASE, summaryStatus: 'failed_review', noticeStatus: 'closed' }),
      'review',
      '复核队列里的事是人工处置，与截止无关',
    );
  });

  it('已截止且 pending → 「未生成摘要」（不再谎称生成中）', () => {
    assert.equal(
      summaryDisplayState({ ...BASE, noticeStatus: SUMMARY_NOT_SUMMARIZED_STATUS }),
      'not-generated',
    );
  });

  it('公示期内（open / resulted）且 pending → 仍说「生成中」，它们确实还在队列里', () => {
    assert.equal(summaryDisplayState(BASE), 'generating');
    assert.equal(
      summaryDisplayState({ ...BASE, noticeStatus: 'resulted' }),
      'generating',
      '入队过滤只排除 closed：resulted 条目照样会被生成',
    );
  });

  it('done 但摘要 JSON 丢失（库里不该出现的状态）→ 保守说「生成中」', () => {
    assert.equal(
      summaryDisplayState({ ...BASE, summaryStatus: 'done' }),
      'generating',
      '这一格只是不崩：真出现说明写入侧有 bug，不该由显示层编一个理由',
    );
  });
});

describe('SUMMARY_NOT_SUMMARIZED_STATUS 是队列与文案共用的唯一答案', () => {
  it('值就是摘要任务排除的那个状态', () => {
    assert.equal(SUMMARY_NOT_SUMMARIZED_STATUS, 'closed');
    // 引用检查读源码而不是复制字面量：入队过滤一旦改回手写 'closed'，本断言即红
    const repoText = readRepoFile('src/db/repo/summaries.ts');
    assert.match(
      repoText,
      /ne\(notices\.status,\s*SUMMARY_NOT_SUMMARIZED_STATUS\)/,
      '入队过滤必须引用同一个常量，否则「会不会生成」又变成两处各写一份',
    );
  });
});
