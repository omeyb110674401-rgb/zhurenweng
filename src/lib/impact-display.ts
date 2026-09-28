import type { NoticeAudience } from './audience.ts';
import type { QuotedImpactPoint } from './summary-content.ts';

/**
 * 「可能的争议点」该不该渲染（issue #86 第 1 刀）。
 *
 * **为什么把这条判据抽成纯函数**：它与 #58 把「未生成摘要」的文案判据抽出来是同一条理由 ——
 * 页面组件（`.tsx`）进不了本仓库的单测（自证框架只认 `node --test` 直读 `.ts`），
 * 而**钉不住的判据等于没有判据**：`check-test-pins.mjs` 撤掉实现要能变红，
 * 撤 `.tsx` 里的分支是撤不出红的（e2e 跑的是 `.next` 构建产物）。
 * 所以"给谁看"这件事留在 `.ts` 里，"怎么画"才留给页面。
 *
 * 两条判据，缺一不可：
 * - **受众面**：用户 2026-09-27 拍板"先只上公众广域 + 人工过一遍"。判读说错的代价不是
 *   "不准确"而是"误导公众"，所以第一版只给最该看见它的那一档。未判定（`null` / `unknown`）
 *   同样不渲染 —— 判不出来就不给它加码。
 * - **非空**：一条都没有时整块不出现，连标题都不出现。空壳比没有更坏（#85 的教训：
 *   一个写着标题、内容却空着的栏目，读者读到的是"这一栏没东西可看"）。
 */
export function shouldRenderImpacts(input: {
  audience: NoticeAudience | null;
  impacts: QuotedImpactPoint[];
}): boolean {
  return input.audience === 'public' && input.impacts.length > 0;
}
