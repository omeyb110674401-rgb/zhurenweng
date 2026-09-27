import { index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL schema（生产方言，ADR-0001）。
 *
 * 这是 ./sqlite.ts 的镜像：列名、约束与语义完全一致，只使用双方言交集子集
 * （TEXT / INTEGER，JSON 存 TEXT 列，时间戳存 ISO 8601 字符串）。
 * 修改任何一表时必须同步修改两个 schema 文件并分别生成迁移：
 * `npm run db:generate`（sqlite）与 `npm run db:generate:pg`（postgresql）。
 */

export const sources = pgTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  adapterType: text('adapter_type').notNull(),
  /** 0 = 不健康 / 1 = 健康（双方言交集内没有 boolean，用 INTEGER 表达） */
  healthy: integer('healthy').notNull().default(1),
  /**
   * 连续失败轮数（issue #58）：判「红」的唯一依据，成功即归零。
   * 与 SQLite 侧同义，见 ./sqlite.ts 的注释。
   */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: text('last_success_at'),
  /**
   * 当前故障态的错误信息与时间（issue #12；issue #58 起成功即清空，不再常驻）。
   */
  lastErrorMessage: text('last_error_message'),
  /** 最近一次错误时间，ISO 8601 */
  lastErrorAt: text('last_error_at'),
  /** 1 = 启用 / 0 = 停用（issue #12 源管理：停用后抓取任务跳过该源） */
  enabled: integer('enabled').notNull().default(1),
});

export const notices = pgTable('notices', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => sources.id),
  title: text('title').notNull(),
  /** 发布机关（忠实于源站的显示值，联合发文为复合串） */
  agency: text('agency').notNull(),
  /**
   * 参与机关集合的竖线包夹串（`|司法部|中国人民银行|`，issue #21）：让「按任一
   * 参与机关筛选」用一条 LIKE '%|X|%' 精确表达，联合发文因此可被任一参与机关
   * 检索到。由入库路径从 agency 推导（src/lib/agencies.ts 的 agencyKeysOf）。
   */
  agencyKeys: text('agency_keys'),
  /** 官方原文 URL，唯一键防重复入库 */
  url: text('url').notNull().unique(),
  publishedAt: text('published_at'),
  /** 截止日期，ISO 8601 */
  deadlineAt: text('deadline_at'),
  /** 征求意见中 open / 已截止 closed / 已出结果 resulted */
  status: text('status').notNull().default('open'),
  /** JSON 存 TEXT：领域标签数组 */
  categoryTagsJson: text('category_tags_json').notNull().default('[]'),
  /** 正文纯文本 */
  bodyText: text('body_text'),
  /** JSON 存 TEXT：附件清单数组（NoticeAttachment[] = [{ name, url }]） */
  attachmentsJson: text('attachments_json').notNull().default('[]'),
  /** JSON 存 TEXT：结构化 AI 摘要（五段式带原文引用，形状见 src/lib/summary-content.ts 的 QuotedSummary） */
  aiSummaryJson: text('ai_summary_json'),
  /** 摘要模型名与版本 */
  summaryModel: text('summary_model'),
  /**
   * 摘要状态（issue #4）：pending 待生成 / done 已生成 / failed_review 重试耗尽待人工复核。
   * 抓取 upsert 不触碰本列（属摘要管线，与 ai_summary_json / summary_model 一致）。
   */
  summaryStatus: text('summary_status').notNull().default('pending'),
  /** 抓取时间，ISO 8601 */
  /** 抓取时间，ISO 8601。**每轮 upsert 都会覆盖**，所以它不是"首次收录"。 */
  fetchedAt: text('fetched_at').notNull(),
  /**
   * 首次收录时间（issue #60 第 3 刀）：只在建行时写入，更新永不覆盖；存量为 NULL。
   * NULL = 本次上线之前就收录 ⇒ 新公示通知一律不覆盖它（否则刚确认的老邮箱会被历史条目轰炸）。
   */
  firstSeenAt: text('first_seen_at'),
  /**
   * 体裁（issue #76）：amendment / new_draft / package_plan / list_or_result / unknown。
   * 摘要管线按它选模板（修正案要"改了哪几处 + 影响"，新案才逐条概括），
   * 判据与优先级见 src/lib/notice-genre.ts。NULL = 本列上线前的存量，没判定过。
   */
  genre: text('genre'),
  /** 凭什么这么判（一句人话，后台展示用）：不许留一个看不出依据的字段，见 #58 删「调度配置」 */
  genreBasis: text('genre_basis'),
  /** 判定用的证据种类（none/title/attachment_names/attachment_text）：弱证据不许覆盖强证据，
   *  否则抓取每轮重写标题会把抽取任务刚升级的判定降回去（详见 src/lib/notice-genre.ts） */
  genreEvidence: text('genre_evidence'),
  /**
   * 受众面（issue #83）：public 公众广域 / sector 行业专业 / unknown 未判定。
   * 与领域标签（category_tags_json）正交：领域答"关于什么事"，受众面答"谁该看、
   * 谁该去提意见"。判据与优先级见 src/lib/audience.ts。
   * NULL = 本列上线前的存量，没判定过（由 scripts/tag-notice-audience.mjs 回填）。
   */
  audience: text('audience'),
  /** 凭什么这么判（一句人话）—— 与体裁同一规矩：不许留一个看不出依据的字段 */
  audienceBasis: text('audience_basis'),
  /** 出站提意点击数（北极星指标） */
  outboundClicks: integer('outbound_clicks').notNull().default(0),
  /**
   * 版本链（issue #10）：本条目的上一轮版本条目 id（notices 自引用）。
   * 由抓取入库时的版本关联逻辑自动维护（src/db/repo/versions.ts，
   * 匹配规则 = 标题规范化 + 同一发布机关）；首版 / 未关联条目为 NULL。
   * 不建自引用外键约束：关联完全由应用层维护，且保持双方言迁移简单。
   */
  versionOf: text('version_of'),
  /** 版本轮次序号（1 = 首轮公示），随 versionOf 一并由版本关联逻辑维护；未关联为 NULL */
  versionSeq: integer('version_seq'),
});

/**
 * 出站提意点击按日聚合（issue #11，北极星指标）。
 *
 * /go/<id> 每次点击写两处：notices.outbound_clicks 总计数（issue #5 起累计）+
 * 本表按（条目 × 本地日历日）+1。只记录条目与日期，不记录任何个人身份
 * （无 IP、无 Cookie、无账号）；复合主键天然幂等，同一日重复点击按行累加，
 * 统计页据此做按条目 / 按日期的 SQL 聚合。
 */
export const outboundClickDaily = pgTable(
  'outbound_click_daily',
  {
    noticeId: text('notice_id')
      .notNull()
      .references(() => notices.id),
    /** 点击日期，本地日历日（YYYY-MM-DD） */
    clickDate: text('click_date').notNull(),
    /** 当日点击次数 */
    clicks: integer('clicks').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.noticeId, table.clickDate] })],
);

/**
 * 任务失败告警发送去重记录（issue #12）：同一天（本地日历日）× 同一任务 ×
 * 同一源只发一封告警邮件，避免同一故障重复轰炸收件箱。复合主键天然幂等，
 * 落表使去重在 worker 重启后依然有效。
 * 与某具体源无关的任务级失败（如索引重建任务抛错）source_id 记为空字符串。
 */
export const alertSends = pgTable(
  'alert_sends',
  {
    /** 告警日期，本地日历日（YYYY-MM-DD），去重键的一部分 */
    alertDate: text('alert_date').notNull(),
    /** 触发告警的任务名（如 crawl-notices） */
    jobName: text('job_name').notNull(),
    /** 源 ID；任务级（与具体源无关）失败用空字符串 */
    sourceId: text('source_id').notNull(),
    /** 发送时间，ISO 8601 */
    sentAt: text('sent_at').notNull(),
    /** 那封告警说了什么（issue #83）：与邮件正文里那段错误摘要同一个字符串；存量为 NULL */
    errorSummary: text('error_summary'),
  },
  (table) => [
    primaryKey({ columns: [table.alertDate, table.jobName, table.sourceId] }),
  ],
);

/**
 * 邮件订阅（issue #7，double opt-in）。
 *
 * - 邮箱唯一：重复订阅同邮箱更新规则而非重复建行；
 * - confirmed = 0（待确认）/ 1（已生效）：未确认的订阅绝不接收任何提醒；
 * - 确认 / 退订各持一个独立随机 token（出现在邮件链接里）；
 * - unsubscribed_at 非空即已退订，之后不再收到任何邮件（行保留，便于审计与防重发）。
 */
export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  /** JSON 存 TEXT：关键词规则数组（命中标题或正文） */
  keywordsJson: text('keywords_json').notNull().default('[]'),
  /** JSON 存 TEXT：领域规则数组（命中条目领域标签） */
  categoriesJson: text('categories_json').notNull().default('[]'),
  /** JSON 存 TEXT：发布机关规则数组（issue #60 第 2 刀，归一后的机关名，逐个精确相等） */
  agenciesJson: text('agencies_json').notNull().default('[]'),
  /**
   * JSON 存 TEXT：受众面收窄条件（issue #84），与 sqlite 侧同结构、同名列。
   * 空数组 = 不限（存量行由此与旧行为逐条一致）；非空时与其余规则是 AND 关系。
   */
  audiencesJson: text('audiences_json').notNull().default('[]'),
  /** 订阅范围（issue #60）：'rules' 按条件 / 'all' 全部新公示；空规则不等于「全部」 */
  scope: text('scope').notNull().default('rules'),
  /**
   * 待确认的规则改动（issue #60 第 4 刀）：JSON = {keywords, categories, agencies, scope}；
   * NULL = 没有待确认的改动。已确认订阅者再次提交时新规则先进这里，**确认之后才套用**到
   * 上面那几列 —— 在此之前提醒与新公示通知仍按旧规则发。
   * 解的是 FOLLOWUPS #52 挂账的「知道某人的邮箱就能重复提交表单静默改写其订阅」：
   * 共享密钥模型下唯一真正管用的门槛不是限流，而是让改动必须经一次确认
   * （确认链接只有能读该邮箱的人点得了）。
   */
  pendingRulesJson: text('pending_rules_json'),
  /** 0 = 待确认 / 1 = 已确认（双方言交集内没有 boolean，用 INTEGER 表达） */
  confirmed: integer('confirmed').notNull().default(0),
  /** 订阅确认令牌（确认邮件链接） */
  confirmToken: text('confirm_token').notNull().unique(),
  /** 一键退订令牌（所有邮件底部链接） */
  unsubscribeToken: text('unsubscribe_token').notNull().unique(),
  /** 确认时间，ISO 8601；未确认为 null */
  confirmedAt: text('confirmed_at'),
  /** 退订时间，ISO 8601；未退订为 null */
  unsubscribedAt: text('unsubscribed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * 提醒发送去重记录（issue #7）：同一条目 × 同一提醒档（7 天 / 3 天）×
 * 同一订阅只发一次。复合主键天然幂等，重复触发任务不会重发。
 */
export const reminderSends = pgTable(
  'reminder_sends',
  {
    noticeId: text('notice_id')
      .notNull()
      .references(() => notices.id),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    /** 提醒档：d7 = 截止前 7 天 / d3 = 截止前 3 天 */
    reminderStage: text('reminder_stage').notNull(),
    /** 发送时间，ISO 8601 */
    sentAt: text('sent_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.noticeId, table.reminderStage, table.subscriptionId] }),
  ],
);

/**
 * 新公示通知去重记录（issue #60 第 3 刀）。与 ./sqlite.ts 的 `noticeNotifications` 是镜像。
 *
 * 一封汇总邮件为其中每条公示各写一行，所以主键是（条目 × 订阅）而不是"每封信一行"；
 * 发送失败的订阅不写行，下一轮重试（与截止提醒同一条 at-least-once 口径）。
 */
export const noticeNotifications = pgTable(
  'notice_notifications',
  {
    noticeId: text('notice_id')
      .notNull()
      .references(() => notices.id),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    sentAt: text('sent_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.noticeId, table.subscriptionId] })],
);

/**
 * 附件抽取状态与本文（issue #57）。与 ./sqlite.ts 的 `noticeAttachments` 是镜像。
 *
 * 为什么是表而不是 `notices` 的列：`attachments_json` 每轮被整体覆盖
 * （`src/db/repo/notices.ts` 的 upsert），按数组下标存的任何状态都活不过一轮；
 * 而一条公示最多 11 个附件、各自成败不同（源站 403 / 非文本 / 扫描件 / 空白意见表），
 * 一列文本装不下「哪个文件产出了这段条文」。主键取 (notice_id, url)：
 * url 是官方给的稳定标识，名称会变、下标会漂，只有它能把跨轮状态对上。
 *
 * `content_hash` 是跨轮缓存键：命中即不再发请求（附件内容稳定，没必要每天下一遍），
 * 这也是本任务不违背 #35「不在抓取期探测附件可达性」那条口径的前提。
 */
export const noticeAttachments = pgTable(
  'notice_attachments',
  {
    noticeId: text('notice_id')
      .notNull()
      .references(() => notices.id),
    /** 附件 URL，原样保存（详情页链接直接指向它） */
    url: text('url').notNull(),
    /** 展示名，每轮随抓取刷新；264/340 个名字没有扩展名，故不作为类型判据 */
    name: text('name'),
    /**
     * 抽取状态：pending 待处理 / ok 已抽出条文 / blocked 源站拒绝（401/403/404）/
     * not_a_file 返回的是 HTML（含 CDN 拦截页）/ too_large 超字节上限 /
     * no_draft_text 抽出的正文过短（空白意见表就是这类）/ scanned_no_text 扫描件 /
     * unsupported_container 解析器抛错 / error 其它失败 / gone 官方已撤下
     */
    status: text('status').notNull(),
    /** 文件类型，按 magic 判（不看扩展名）：pdf / docx / doc / other */
    kind: text('kind'),
    /** 实际下载字节数 */
    bytes: integer('bytes'),
    /** sha256(body)：跨轮缓存键 */
    contentHash: text('content_hash'),
    /** 抽出字符数（`no_draft_text` 的判据） */
    charCount: integer('char_count'),
    /** 抽取出的纯文本，入库前截断 */
    extractedText: text('extracted_text'),
    /** 失败摘要（含 HTTP 状态），只用于排查与「为什么读不到」的文案 */
    error: text('error'),
    /** 0 = 未喂给模型 / 1 = 本轮摘要用到了它 */
    fedToSummary: integer('fed_to_summary').notNull().default(0),
    /** 尝试次数（含被熔断跳过的轮次） */
    attemptCount: integer('attempt_count').notNull().default(0),
    /** 首次见到该 URL 的时间，ISO 8601 */
    firstSeenAt: text('first_seen_at').notNull(),
    /** 最近一次在附件清单里见到它的时间；长期不刷新即官方已撤下 */
    lastSeenAt: text('last_seen_at').notNull(),
    /** 最近一次真的发请求的时间（`blocked` 按它做 7 天退避） */
    lastFetchAt: text('last_fetch_at'),
  },
  (table) => [
    primaryKey({ columns: [table.noticeId, table.url] }),
    index('notice_attachments_status_idx').on(table.status, table.noticeId),
  ],
);
