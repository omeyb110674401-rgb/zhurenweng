#!/usr/bin/env node
/**
 * 真实布局量具：CDP 直连 headless Chrome，读**渲染后的几何数字**。
 *
 * ## 为什么它在仓库里，而不只是开发机上的一个草稿
 *
 * 本仓库的 e2e **没有浏览器**（ADR-0001：不引 Playwright 那一类依赖），所以媒体查询、
 * sticky、行宽、横向溢出、首屏能装下几条 —— 全都只能靠"源码文本断言"，而那种断言
 * 证明不了页面真的排成了什么样。2026-10-02 详情页两栏那一刀把这件事演到了极端：
 * `tsc` / `eslint` / 单测 / e2e **全绿而页面是坏的**，两个缺陷（右栏被写进主栏内部、
 * 宽度写在子元素上压不过父容器）**都是这只量具抓出来的**。所以它不再留在 `.git/` 下。
 *
 * 它**不进 e2e**、不进 `npm test`：它是"改动涉及版式时人工跑一次"的工具，不是门。
 * 把它接进门会让测试依赖本机装没装 Chrome —— 那是拿一个更脆的门换一个更真的读数。
 *
 * ## 用法
 *
 *   node scripts/measure-rendered-geometry.mjs <url> <宽,高> [<宽,高> …]
 *   node scripts/measure-rendered-geometry.mjs http://127.0.0.1:3000/ 1440,900 375,800
 *
 * Chrome 路径按 `ZW_CHROME` 环境变量 → 几个常见安装位置 的顺序找；找不到会明确报错
 * （而不是静默什么都不输出 —— "相对路径截图静默不出产物"那个坑已经踩过一次）。
 *
 * **只读**：不写任何文件、不动被跟踪的文件；每个视口开一个标签页、量完就关。
 *
 * 读出来的数字里，两个最容易骗人的分别是：
 * - `horizontalOverflow`：`scrollWidth > innerWidth + 1` —— 差一个像素不算（亚像素舍入）；
 * - `listItemsInFirstScreen`：只数**整条都在首屏内**的条目（`bottom <= innerHeight`），
 *   半条露在下面的不算 —— "看起来有 3 条"与"能读完 3 条"是两件事。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 常见安装位置；`ZW_CHROME` 优先。找不到就报错，不静默。 */
const CANDIDATES = [
  process.env.ZW_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((candidate) => typeof candidate === 'string' && candidate !== '');

const CHROME = CANDIDATES.find((candidate) => existsSync(candidate));

const url = process.argv[2];
const sizes = process.argv.slice(3).map((s) => s.split(',').map(Number));
if (!url || sizes.length === 0 || sizes.some(([w, h]) => !(w > 0) || !(h > 0))) {
  console.error('用法：node scripts/measure-rendered-geometry.mjs <url> <宽,高> [<宽,高> …]');
  process.exit(2);
}
if (CHROME === undefined) {
  console.error(
    `找不到 Chrome。设 ZW_CHROME 指向可执行文件，或确认它在这几个位置之一：\n  ${CANDIDATES.join('\n  ')}`,
  );
  process.exit(2);
}

const PORT = 9333 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(path.join(tmpdir(), 'zw-measure-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 的调试端口没起来');
}

/**
 * 探针表达式。**详情页与列表页的指标放在同一份里**，缺的元素一律 null ——
 * 于是同一个命令既能量详情页也能量列表页，不必为每一页维护一份量具
 * （量具分家＝两个口径，本项目已经栽过多次）。
 */
const EXPR = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (el) => el === null ? null : (() => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
  })();
  const charsPerLine = (sel) => {
    const el = q(sel);
    if (el === null) return null;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    return Math.round(el.getBoundingClientRect().width / fs);
  };
  const grid = q('.detail-grid');
  const rail = q('.detail-rail');
  const impacts = q('[data-testid="summary-impacts"]');
  const firstImpact = q('[data-testid="summary-impacts"] li');
  const cta = q('[data-testid="go-official-button"]');
  const items = [...document.querySelectorAll('[data-testid="notice-item"]')];
  const fullyVisible = items.filter((el) => el.getBoundingClientRect().bottom <= innerHeight + 1);
  const doc = document.documentElement;
  return {
    viewport: { w: innerWidth, h: innerHeight },
    scrollWidth: doc.scrollWidth,
    horizontalOverflow: doc.scrollWidth > innerWidth + 1,
    container: box(q('.page')),
    grid: box(grid),
    main: box(q('.detail-main')),
    rail: box(rail),
    railIsGridChild: rail !== null && rail.parentElement === grid,
    ctaCount: document.querySelectorAll('[data-testid="go-official-button"]').length,
    ctaInFirstScreen: cta !== null && cta.getBoundingClientRect().top < innerHeight,
    impactsInFirstScreen: impacts !== null && impacts.getBoundingClientRect().top < innerHeight,
    firstImpactInFirstScreen: firstImpact !== null && firstImpact.getBoundingClientRect().top < innerHeight,
    firstImpactTop: firstImpact === null ? null : Math.round(firstImpact.getBoundingClientRect().top),
    summaryLineChars: charsPerLine('.summary-section-text'),
    bodyLineChars: charsPerLine('.body-text'),
    whoSectionPresent: q('[data-testid="summary-who"]') !== null,
    listItemCount: items.length,
    listItemsInFirstScreen: fullyVisible.length,
    firstItemTop: items.length === 0 ? null : Math.round(items[0].getBoundingClientRect().top),
    itemHeight: items.length === 0 ? null : Math.round(items[0].getBoundingClientRect().height),
    /*
     * 列表页两栏（2026-10-02）：**筛选条与列表谁在左、各占多宽**。
     * 为什么必须量这两格：那一刀的第一版靠栅格自动放置，结果筛选条占掉主栏、
     * 列表被塞进 320px 的右栏 —— 而 e2e（没有浏览器）与源码文本断言都看不出来。
     * 判据：宽屏下 filterBar.left 应**大于** noticeList.left（rail 在右），
     * 且 noticeList.w 明显大于 filterBar.w。
     * （这段注释在模板字符串里，**不许出现反引号** —— 一个反引号就把表达式截断了，
     *   本轮踩过：报错是 "Unexpected identifier"，看着像探针写错，其实是注释。）
     */
    filterBar: box(q('[data-testid="notice-filter-bar"]')),
    noticeList: box(q('.notice-list')),
  };
})()`;

await waitForDevtools();

const results = [];
for (const [w, h] of sizes) {
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(2500); // 服务端渲染的页面，等它画完就够
  const res = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  results.push({ size: `${w}x${h}`, ...(res.result?.result?.value ?? { error: JSON.stringify(res) }) });
  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
}

console.log(JSON.stringify(results, null, 2));

chrome.kill();
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* Windows 上偶尔删不掉，无所谓 */
}
