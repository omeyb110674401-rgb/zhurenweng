import type { ReactNode } from 'react';
import {
  CHANNEL_LABELS,
  hasBriefContent,
  type NoticeBrief,
  type NoticeChannel,
} from '@/lib/notice-brief';

/**
 * 结构化速读与提交方式（issue #27）——把 issue #26 的确定性抽取渲染出来。
 *
 * 两块内容、两个支柱，刻意不重复：
 * - `SubmissionChannels`（行动）：原文注明的提交渠道，放在「去官方渠道提意见」
 *   按钮旁。**只要有就渲染，与 AI 摘要无关**——它是原文原句，比模型叙述更该
 *   被放在行动位置；
 * - `NoticeBriefView`（读懂）：一句话速读 + 文件名 + 原文分条要点。**只在没有
 *   AI 摘要时渲染**——有摘要时五段式已覆盖同样内容，重复展示只会稀释页面。
 *
 * 视觉上刻意与 AI 摘要区分：AI 摘要是琥珀色 + 「AI 摘要」标签，本块是中性灰蓝 +
 * 「结构化速读」标签 + 「非 AI 生成」说明。读者一眼能看出这段话是谁说的——
 * 这是合规姿态，也是本产品敢把机器输出放在官方原文前面的前提。
 *
 * 两个组件都是纯展示：`brief` 由页面（或调用方）算一次后传入，避免同一份正文
 * 被反复解析。
 */

/** 单条渠道：值可点击（邮箱/电话/网址），原文上下文以小字附在下方供核对。 */
function ChannelItem({ channel }: { channel: NoticeChannel }): ReactNode {
  const value =
    channel.href === null ? (
      <span className="channel-value">{channel.value}</span>
    ) : (
      <a
        className="channel-value"
        href={channel.href}
        target={channel.kind === 'online' ? '_blank' : undefined}
        rel={channel.kind === 'online' ? 'noopener noreferrer' : undefined}
      >
        {channel.value}
      </a>
    );

  return (
    <li className="channel-item" data-testid="submission-channel" data-channel-kind={channel.kind}>
      <span className="channel-kind">{CHANNEL_LABELS[channel.kind]}</span>
      {value}
      {channel.context === null ? null : <p className="channel-context">原文：{channel.context}</p>}
    </li>
  );
}

/**
 * 提交方式块（行动支柱）。
 *
 * 此前这里只有一句泛泛的「通常可通过在线表单、电子邮件或信函提出」——而官方原文
 * 里其实写着具体邮箱、传真与通信地址。把原文的渠道摆出来，是本站从「告诉你要提意见」
 * 走到「告诉你往哪儿提」的关键一步；取不到时整块不渲染，绝不编一条凑数。
 */
export function SubmissionChannels({ channels }: { channels: NoticeChannel[] }): ReactNode {
  if (channels.length === 0) return null;

  return (
    <div className="channels" data-testid="submission-channels">
      <p className="channels-title">意见提交方式（摘自官方原文）</p>
      <ul className="channels-list">
        {channels.map((channel) => (
          <ChannelItem key={`${channel.kind}:${channel.value}`} channel={channel} />
        ))}
      </ul>
      <p className="channels-note">
        以上为官方原文中的原句摘录，本站未做改写；提交请以官方渠道为准。
      </p>
    </div>
  );
}

/** 速读卡（读懂支柱）：仅在无 AI 摘要时渲染。 */
export function NoticeBriefView({ brief, url }: { brief: NoticeBrief; url: string }): ReactNode {
  if (!hasBriefContent(brief)) return null;

  return (
    <section className="brief-card" data-testid="notice-brief">
      <div className="brief-head">
        <span className="brief-tag">结构化速读</span>
        <span className="brief-origin" data-testid="brief-origin">
          非 AI 生成：逐字摘自官方原文
        </span>
      </div>

      {brief.leadParagraph === null ? null : (
        <blockquote className="brief-lead" data-testid="brief-lead">
          <p>{brief.leadParagraph}</p>
          <a className="brief-lead-jump" href={url} target="_blank" rel="noopener noreferrer">
            核对官方原文↗
          </a>
        </blockquote>
      )}

      {brief.documentNames.length === 0 ? null : (
        <div className="brief-field" data-testid="brief-document-name">
          <span className="brief-field-label">文件名称</span>
          <span className="brief-field-value">
            {brief.documentNames.map((name) => `《${name}》`).join(' ')}
            {brief.documentKind === null ? null : (
              <span className="brief-kind">{brief.documentKind}</span>
            )}
          </span>
        </div>
      )}

      {brief.keyItems.length === 0 ? null : (
        <div className="brief-field" data-testid="brief-key-items">
          <span className="brief-field-label">原文分条要点</span>
          <ul className="brief-items">
            {brief.keyItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="brief-note">
        本块由程序按固定规则从官方原文中摘录，未经大模型改写，也不代表本站观点。
      </p>
    </section>
  );
}
