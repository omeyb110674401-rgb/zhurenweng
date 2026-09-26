import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorMessage } from '../../src/lib/errors.ts';

/**
 * 单元（issue #83）：错误 → 消息文本。
 *
 * 两行的函数也值得一条测试，理由不在"它会不会写错"，而在**它现在只有一份实现**：
 * 此前 5 个 worker 任务各抄了一份，谁都不会去改别人的那份，于是同一件故障在日志、
 * 告警邮件、后台「当前错误信息」列里可能显示成三种样子 —— 而那正是排查时唯一能对照的线索。
 * 这条测试同时是 pin 自证的落点（撤掉 `instanceof Error` 那一行必须变红）。
 */

describe('issue #83：错误消息归一', () => {
  it('Error 实例取 message（日志里要的是那句话，不是 [object Object]）', () => {
    assert.equal(errorMessage(new Error('源站返回 403')), '源站返回 403');
    // 自定义错误子类同样走 message
    class CrawlTimeout extends Error {}
    assert.equal(errorMessage(new CrawlTimeout('抓取超时 5000ms')), '抓取超时 5000ms');
  });

  it('非 Error 的抛出物退回 String()（`throw "字符串"` 在 JS 里真的会发生）', () => {
    assert.equal(errorMessage('直接抛的字符串'), '直接抛的字符串');
    assert.equal(errorMessage(404), '404');
    assert.equal(errorMessage(undefined), 'undefined');
    assert.equal(errorMessage(null), 'null');
    // 普通对象没有更好的说法，String() 会给出 [object Object] —— 那是事实，不编
    assert.equal(errorMessage({ code: 1 }), '[object Object]');
  });

  it('Error 连 message 为空时返回空串（不替它编一句话，调用方自己决定怎么显示）', () => {
    assert.equal(errorMessage(new Error('')), '');
  });
});
