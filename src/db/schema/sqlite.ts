import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema（开发 / 测试方言，ADR-0001）。
 *
 * 方言交集约定：
 * - 只使用 TEXT / INTEGER 列，不用任何 PG 专属类型；
 * - JSON（领域标签、AI 摘要、附件清单等）一律存 TEXT 列，由应用层序列化；
 * - 时间戳存 ISO 8601 字符串。
 *
 * PostgreSQL 镜像 schema 见 ./postgres.ts，两者列名与语义必须保持一致。
 */

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  adapterType: text('adapter_type').notNull(),
  /** 0 = 不健康 / 1 = 健康（双方言交集内没有 boolean，用 INTEGER 表达） */
  healthy: integer('healthy').notNull().default(1),
  /**
   * 连续失败轮数（issue #58）：判「红」的**唯一**依据是它过门槛（见 source-health 的
   * `isSourceUnhealthy`），而不是「本轮抛了一次错」。抓取失败一次就翻红、又只有日历日
   * 去重，会让一个间歇性慢源每天红一次、每天一封告警，永远不收敛。成功即归零。
   */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: text('last_success_at'),
  /**
   * 最近一次管线错误信息 / 时间（issue #12 源健康看板）。
   *
   * 语义在 issue #58 收窄为「**当前**故障态」：抓取成功即清空。原先「成功不清空，便于
   * 排查曾停摆的源」把「现在有没有事」和「上次出了什么事」压进同一对列，代价是看板
   * 永远挂着一条几周前的红字。历史不丢 —— worker 日志每轮都带原因，`consecutive_failures`
   * 就是「曾停摆」的持久化替身。
   */
  lastErrorMessage: text('last_error_message'),
  /** 最近一次错误时间，ISO 8601 */
  lastErrorAt: text('last_error_at'),
  /** 1 = 启用 / 0 = 停用（issue #12 源管理：停用后抓取任务跳过该源） */
  enabled: integer('enabled').notNull().default(1),
});

export const notices = sqliteTable('notices', {
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
  /**
   * 摘要调用的诊断（issue #86 第 0 刀）：产出当前这列摘要的那一次调用里，模型吐了什么、
   * 我们丢了什么、丢在哪一关。形状与理由见 src/lib/summary-diagnostics.ts。
   *
   * 为什么是独立的列：`ai_summary_json` 是**渲染契约**，往里加键就要同时改读侧，而读侧
   * 一旦判形状异常，存量条目会从「有摘要」掉回「待人工复核」占位（#85 的教训）。这一列
   * 只给审计脚本与后台看，能独立清空/裁剪而不牵动任何页面。
   * NULL = 本列上线前的存量，或那份摘要是人工复核手工录入的（没有调用可描述）。
   */
  summaryDiagnosticsJson: text('summary_diagnostics_json'),
  /**
   * 审读记录（issue #47）：产出当前这列摘要的那一批判读，各自被一路**独立模型**
   * 判过合规性没有、判成了什么。形状与理由见 src/lib/impact-review.ts。
   *
   * 为什么是独立的列、而不是塞进 `ai_summary_json`：那一列是**渲染契约**，往里加键
   * 就要同时改读侧（#85 的教训同上一条）。而且审读层必须**可抛弃** ——
   * 生成侧重跑之后，旧的审读结论按内容指纹自动失效，这一列要能被独立清空、独立裁剪，
   * 坏掉也不牵动任何页面。NULL = 这一条没有审读层的数据（本列上线前的存量、
   * 人工复核手工录入的摘要、或审读还没跑/没跑成）。
   */
  impactReviewJson: text('impact_review_json'),
  /** 抓取时间，ISO 8601。**每轮 upsert 都会覆盖**，所以它不是"首次收录"。 */
  fetchedAt: text('fetched_at').notNull(),
  /**
   * 首次收录时间（issue #60 第 3 刀）：只在建条目那一行时写入，之后**任何更新都不碰它**。
   *
   * 为什么需要它：新公示通知要判断"这条是不是新的"，而 `fetched_at` 每天被抓取覆盖
   * （标题或截止日期修正也会刷新它），拿它当"新"就会把三个月前的条目天天重发。
   * **存量为 NULL 且不回填**：NULL 表示"本次上线之前就在了"，一律不算新 ——
   * 这样任何订阅者都不可能被历史条目轰炸（尤其是一个老邮箱刚确认订阅就收到 187 封的场景）。
   */
  firstSeenAt: text('first_seen_at'),
  /**
   * 体裁（issue #76）：amendment 修正案 / new_draft 新案草案 / package_plan 打包清单 /
   * list_or_result 名单结果 / unknown 未判定。摘要管线按它选模板 —— 读者对修正案要的是
   * "改了哪几处、为什么、影响谁"，对新案要的才是"每章每条规定了什么"，一套提示词服务两种
   * 需求只会两边都不到位。判据与优先级见 src/lib/notice-genre.ts。
   * NULL = 本列上线前的存量（没判定过），不等于 unknown。
   */
  genre: text('genre'),
  /** 凭什么这么判（一句人话，后台展示用）：不许留一个看不出依据的字段，见 #58 删「调度配置」 */
  genreBasis: text('genre_basis'),
  /** 判定用的证据种类（none/title/attachment_names/attachment_text）：弱证据不许覆盖强证据，
   *  否则抓取每轮重写标题会把抽取任务刚升级的判定降回去（详见 src/lib/notice-genre.ts） */
  genreEvidence: text('genre_evidence'),
  /**
   * 受众面（issue #83）：这条公示**该谁来看、该谁去提意见** ——
   * public 公众广域（立法 / 税收 / 社保医保等，影响不特定多数人）/
   * sector 行业专业（技术标准、行业规程、许可准入，读者以从业者为主）/
   * unknown 判不出来（不兜底）。判据与优先级见 src/lib/audience.ts。
   *
   * 与领域标签 `category_tags_json` 是**两个正交维度**：领域答"关于什么事"，
   * 受众面答"谁该看" —— 一条《城市绿地设计标准（修订征求意见稿）》属于「生态环境」，
   * 却是「行业专业」。列表页筛选与详情页角标读的都是这一列。
   * NULL = 本列上线前的存量，没判定过（由 scripts/tag-notice-audience.mjs 回填）。
   */
  audience: text('audience'),
  /** 凭什么这么判（一句人话，后台与审计脚本展示用）—— 与体裁同一规矩：不许留看不出依据的字段 */
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
export const outboundClickDaily = sqliteTable(
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
export const alertSends = sqliteTable(
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
    /**
     * 那封告警说了什么（issue #83）：与邮件正文里那段错误摘要同一个字符串。
     *
     * 为什么必须补这一列：此前表里只有「哪天、哪个任务、哪个源、几点发的」——
     * 09-21 起站长收到过 14 封告警，**内容已不可考**（邮件在收件箱里翻了才看得到，
     * 而"当时到底报了什么"恰恰是事后复盘唯一需要的信息）。成本一列，价值是"以后查得到"。
     * 存量行的该列为 NULL（那时没记），页面与 SQL 一律按"未记录"显示，不猜。
     */
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
export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  /** JSON 存 TEXT：关键词规则数组（命中标题或正文） */
  keywordsJson: text('keywords_json').notNull().default('[]'),
  /** JSON 存 TEXT：领域规则数组（命中条目领域标签） */
  categoriesJson: text('categories_json').notNull().default('[]'),
  /**
   * JSON 存 TEXT：发布机关规则数组（issue #60 第 2 刀，归一后的机关名）。
   * 匹配时对条目的复合机关串（`splitAgencies`）逐个精确相等，不做子串。
   */
  agenciesJson: text('agencies_json').notNull().default('[]'),
  /**
   * JSON 存 TEXT：受众面收窄条件（issue #84），取值是 `audience.ts` 的 'public' / 'sector'。
   * **空数组 = 不限**（本列上线前建的订阅全部落在这里，行为与旧版逐条一致）；
   * 非空时与关键词 / 领域 / 机关是 **AND** 关系，不是"又一档命中即可"：
   * 那三项回答"这条跟我有没有关系"，受众面回答"这类公示是不是给我看的"。
   */
  audiencesJson: text('audiences_json').notNull().default('[]'),
  /**
   * 订阅范围（issue #60）：'rules' = 只收命中关键词 / 领域 / 机关的条目；
   * 'all' = 收录的全部新公示。刻意不用「规则为空即视为全部」表达后者 ——
   * 空规则更可能是漏填，把漏填解释成「订全部」会让用户事后才发现自己没设过条件。
   */
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
export const reminderSends = sqliteTable(
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
 * 新公示通知去重记录（issue #60 第 3 刀）：同一条目对同一订阅只进一次汇总邮件。
 *
 * 一封汇总邮件会为其中每条公示各写一行 —— 主键因此是（条目 × 订阅）而不是"每封信一行"。
 * 发送失败的订阅**不写行**，下一轮重试（与截止提醒同一条 at-least-once 口径）。
 */
export const noticeNotifications = sqliteTable(
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
 * 附件抽取状态与本文（issue #57）。
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
export const noticeAttachments = sqliteTable(
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
