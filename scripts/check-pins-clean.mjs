import { existsSync, readFileSync } from 'node:fs';

/**
 * 门的前置检查：`check-test-pins.mjs` 上一次有没有被**强杀在半路**。
 *
 * 那个脚本靠「撤掉实现、要求测试变红」自证，所以它运行期间工作区里**真的躺着假代码**。
 * 正常结束会还原；被强杀则留下 `.pins-inflight.json` 留痕，而自愈只在**它自己下一次
 * 启动**时才发生 —— 在那之前跑测试，看到的就是一批与被测改动毫无关系的红。
 *
 * 2026-09-25 实测踩到：`check-test-pins.mjs` 被外层 120s 超时杀掉，紧接着 `npm run e2e`
 * 报出 5 条 `crawl-timeout-guard` 失败，症状是「停滞请求跑满 5s 完全不超时」，看着像抓取
 * 层的真回归 —— 而真原因只是那行 `signal: AbortSignal.timeout(timeoutMs)` 被撤掉了。
 * 定位它花的时间比修它长，所以把这个状态**提到门的入口**来说：报出留痕、说明后果、
 * 给出唯一正确的下一步，而不是让调用者对着一堆假红自己猜。
 *
 * 挂在 `pretest:unit` / `pree2e` / `prebuild` 上（见 package.json）。
 * 注意 `pretest`（= `check-test-pins.mjs` 本体）**不**挂这个守卫：它自己启动时就会自愈
 * （见 `recoverInflight`），在它前面再加一道只会把同一件事说两遍。
 * 它是纯读的：只报告，不替人做还原 —— 还原交给 `--recover-only`，
 * 那条路径有它自己的守卫（文件被人工改过时不许自动写回）。
 */

const MARKER = '.pins-inflight.json';

if (existsSync(MARKER)) {
  let label = '（留痕文件读不出来，无法说出是哪一条）';
  try {
    // 去掉可能的 BOM：留痕是人可能手改的文件，读不出名字不该让这条报告失去价值
    const raw = readFileSync(MARKER, 'utf8').replace(/^\uFEFF/, '');
    label = JSON.parse(raw).label ?? label;
  } catch {
    // 留痕坏了也照样拦：拦的依据是"它还在"，不是"它可读"
  }
  console.error(
    [
      '',
      '!! 工作区里留着 `.pins-inflight.json` —— 上一次 `check-test-pins.mjs` 被强杀在半路。',
      `   当时撤的是：「${label}」`,
      '',
      '   这意味着**源码里现在可能躺着被撤掉的假实现**，直接跑测试会得到一批',
      '   与被测改动毫无关系的红（2026-09-25 实测：5 条 crawl-timeout-guard 失败，',
      '   看着像抓取层回归，其实只是那行 timeout signal 被撤掉了）。',
      '',
      '   先还原，再跑门：',
      '     node scripts/check-test-pins.mjs --recover-only',
      '',
      '   跑完之后 `git status` 应当是干净的；若它报「文件之后又被改过」，',
      '   按提示 `git diff <文件>` 人工核对那一处。',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
