import type { ReactNode } from 'react';
import Link from 'next/link';
import { IcpFiling } from '@/app/_lib/icp-filing';
import { mailerReady } from '@/lib/mailer-availability';
import { llmReady } from '@/lib/llm-availability';

/**
 * 全站页脚（issue #53）。
 *
 * 此前 12 个页面各写一份页脚，文案互不相同，而且 **ICP 备案号只有 3 个页面有**
 * （首页、搜索页、404）。备案号要在站点所有页面底部可见 —— 这是合规要求，
 * 不只是观感问题；顺带补上站内导航（此前 /stats 与 /subscribe 只能从首页互达，
 * 详情页、统计页之间没有任何互链）。
 *
 * `note` 是给少数页面保留自己那段说明用的（统计页的隐私边界、对比页的比对口径），
 * 其余页面共用下面的标准文案（两个版本，见 `NOTE_WITH_AI`）。
 *
 * 订阅入口与首页导航同门控（`mailerReady`）：邮件端口未配置时不渲染指向
 * `/subscribe` 的链接 —— 该页此刻只会给出「暂未开放」。这条被
 * tests/e2e/subscribe-availability.test.mjs 反向钉住（首页不得出现 href="/subscribe"）。
 */

/**
 * 标准文案的两个版本（issue #54）：AI 那半句按 `llmReady()` 决定说不说。
 *
 * 详情页的「AI 摘要」区块本来就由 `llmReady()` 门控（`notices/[id]/page.tsx`），
 * 未配置大模型端口时对外显示的是「AI 结构化解读尚未启用」。但页脚这句话是**全站**
 * 承诺，于是线上出现过自相矛盾的画面：每个页面底部写着「AI 生成内容将显著标注」，
 * 而抽样 20/20 的详情页根本没有 AI 摘要。
 *
 * 门控而不是删掉：配好 `LLM_PROVIDER` + 密钥后这句话自动重新成立，不必再改代码 ——
 * 与订阅入口用的是同一种处理方式。未启用时的措辞只说程序摘录这一件事，
 * 「结构化速读」确实是逐字摘自官方原文、不经过大模型。
 */
const NOTE_WITH_AI =
  '本站只聚合官方公开信息并提供解读（AI 生成内容将显著标注）；提交意见请一律前往官方渠道，意见的法律效力以官方渠道为准。';

const NOTE_NO_AI =
  '本站只聚合官方公开信息，内容由程序按固定规则从官方原文中摘录、不经过改写；提交意见请一律前往官方渠道，意见的法律效力以官方渠道为准。';

export function SiteFooter({ note }: { note?: ReactNode }) {
  return (
    <footer className="site-footer">
      <p>{note ?? (llmReady() ? NOTE_WITH_AI : NOTE_NO_AI)}</p>
      <nav className="footer-nav" data-testid="site-footer-nav" aria-label="页脚导航">
        <Link href="/">首页</Link>
        <Link href="/stats">数据统计</Link>
        {mailerReady() ? <Link href="/subscribe">订阅提醒</Link> : null}
        {/* RSS 是路由处理器而不是页面，用普通 <a>（Link 会去预取 RSC 载荷） */}
        <a href="/feed.xml">RSS 订阅</a>
      </nav>
      <IcpFiling />
    </footer>
  );
}
