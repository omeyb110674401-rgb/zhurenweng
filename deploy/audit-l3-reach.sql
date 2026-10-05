-- deploy/audit-l3-reach.sql —— 【只读】L3 判读（「可能的争议点」）的触达口径
--
-- 为什么要有它（issue #87 收尾，2026-10-03）：列表页标记（#87）已上线，而它把一句
-- 此前只存在于文档里的数字变成了**读者能看见的东西** —— 线上首页一屏 50 条里只有 4 条带标记。
-- 于是"11/97 条摘要带判读"这笔老账必须被拆开：**11 是结果，不是原因**。
-- 第一次跑出来的结论就不是原本以为的那个（见 `87-list-page-discoverability.md` §9），
-- 所以这个脚本存在的意义是**让这句话以后每次都能重新量**，而不是把一次的读数抄进文档。
--
-- 它要回答的是"卡在哪一关"，而各关的处置**完全相反**：
--
--   a. **一份都没喂**（fed = 0）：这一条生成摘要时一份条文都没送进提示词（可读附件 0 份，
--      或喂进来的全是公告壳）。提示词明令"没有附件条文段落时 impacts 必须为空"
--      ⇒ 这一档**结构上不可能**有判读，它要的是**抓取侧的活**（补附件、换源）。
--   b. **喂了、模型没吐**（fed > 0 且 emitted = 0）⇒ 提示词/能力问题（要动的是 #86 那张表）。
--   c. **吐了、被反查吃掉**（emitted > 0 且 kept = 0）⇒ **我们的校验器**的问题。
--      #79 卡住的就是这一档不可区分；#86 第 0 刀立 `summary_diagnostics_json` 正是为它。
--   d. **落库了、被受众面挡住**（kept > 0 且 `audience <> 'public'`）⇒ **产品决定**
--      （用户 2026-09-27 拍板"先只上公众广域 + 人工过一遍"），也正是
--      `88-detail-page-layout.md` §6 第 4 条那个一直挂着的风险决定
--      （**L3 要不要扩到行业专业档**）的全部代价。
--   x. **没有诊断**（`summary_diagnostics_json` 为空）⇒ **量具本身不存在**，无法归因。
--      这一档在第一次跑时占 97 条里的 80 条，是这次读数里最大的一项，也是
--      "11/97 是不是产出率"这个问题的关键：**没有诊断的摘要，绝大多数是判读这一层
--      还不存在时生成的**（那时提示词里没有 `impacts` 字段），不是"模型没想到影响"。
--
-- 口径与代码逐条对应（**不在这里另立一套判据**）：
--   · `impacts` 取 `ai_summary_json -> 'impacts'` 的实际数组长度。落库侧只在非空时才写这个键
--     （`openai-compatible-llm.ts`：`...(impacts.length > 0 ? { impacts } : {})`），
--     所以"键缺席"与"空数组"是同一件事，且**缺席才是常态**；键值为 JSON null 也当 0
--     （`parseStoredImpacts` 同样当空）⇒ 一律走 `jsonb_typeof` 判型再取长度，不用 `->` 直接取
--     （那会在 `"impacts": null` 上报 cannot get array length of a scalar）。
--   · `feed.sources` / `emitted.impacts` / `kept.impacts` 取 `summary_diagnostics_json`。
--     `feed` 是 **v2** 才有的键；v1 的存量行没有它，而**"没记"与"喂了 0 份"处置相反**
--     （前者是没量具，后者是抓取侧没给料）⇒ v1 行在分档里**单列一档**，不混进 a 档。
--   · 「能不能渲染」= 渲染门 `impactsToRender` 的判据（issue #52 起是**严格版**）：
--     **只有"有有效审读记录"的判读才渲染**，而"有效"= `impact_review_json` 里存在一条记录，
--     它的 `quoteFingerprint` / `textFingerprint` 与这条判读的 `quote` / `text`
--     **归一化之后**相等、且 `status` 不是 `rejected`（`revised` 渲染审读后文本、`passed` 渲染原文）。
--     **受众面已退出判据**（第 ⑥⑦ 与第 5/6 节据此改写）。归一化口径与 JS 侧
--     `quoteFingerprint` 同一把尺子（引号字形归一 → 去空白 → 去包裹引号），由本会话里的
--     `pg_temp.zw_fingerprint()` 表达；**已知的一处残留差异**：JS 的 `\s` 还覆盖 NBSP 等
--     Unicode 空白，而 Postgres 的 `[[:space:]]` 在 C locale 下只覆盖 ASCII（全角空格已显式列出）。
--     这类字符在实际正文里未出现过，且方向是"SQL 少数"（更保守）；开门核验时把本脚本与
--     `scripts/review-impacts-now.mjs`（走 JS 那份判据）对一遍即可确认逐条一致。
--   · 「还没截止」用展示口径（`effectiveStatus`）：库内 `status` 是抓取时推导的，刚过截止的
--     条目能挂十几个小时仍是 `open`（见 `notice-status.ts` 头注的生产实测）⇒ 两列都看，
--     并按 **Asia/Shanghai** 的当天比较（库容器是 UTC，`now()::date` 会在北京时间 0–8 点差一天）；
--     截止日为空时按"还没截止"算 —— 与 `effectiveStatus` 的 `days === null ⇒ open` 一致。
--
-- 跑法（**不写库、不碰 /opt**）：
--   cat deploy/audit-l3-reach.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng
-- 迁移 0019 / 0020 之前会分别报 `summary_diagnostics_json` / `impact_review_json` 不存在，那是预期。
--
-- 唯一"写"的东西是两个 **TEMPORARY VIEW** 与一个 **`pg_temp` 函数**（归一化指纹那个）：
-- 只活在这个 psql 会话里、断开即消失，对库不留任何痕迹。用它们的理由是不必把上面那四十行
-- 口径在十个小节里抄十遍 —— 抄十遍的那一份，迟早有几处走样，而这类脚本一旦两节口径不一致，
-- 读的人不会怀疑脚本，会怀疑数据。
--
-- 结构上有两处**不是风格问题**：
--   ① `s` / `d` / `r` 必须在 `base` 这一层就物化成列，不能在同一个 select 列表里往下引用
--      （Postgres 里同一层 select 的别名互不可见，写成一层的直接报 `column "s" does not exist`）。
--   ② 归因分档必须是**一个 `case` 表达式**（互斥），不能是一串 `count(*) filter (...)`
--      —— 后者各档可以重叠，而重叠的表现是**各档之和 > 总数**：本脚本第一版就在 97 行的
--      分母上数出了 98。一个各部分之和大于整体的漏斗，读的人不会发现它错了，
--      只会觉得"数据有点怪"。**看不见的缺口**正是本项目定义缺陷的方式，所以第 3 节
--      自带一条"分档合计 = 总数"的自检。

\pset border 2

/**
 * 判读/审读记录的**内容指纹**（issue #47/#52）：与 JS 侧 `quoteFingerprint` 同一把尺子 ——
 * 引号字形归一 → 去全部空白（含全角空格）→ 去掉包裹引号。
 *
 * 为什么要它：审读记录里存的就是**归一化之后的**两个指纹，而判读里存的是原样的 `quote`/`text`。
 * 门是这么比的，量具就必须这么比 —— 各写一份的表现是"量具说能渲染、页面却不渲染"。
 */
create function pg_temp.zw_fingerprint(t text) returns text language sql immutable as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(coalesce(t, ''), '[“”＂〝〞「」『』]', '"', 'g'),
               '[‘’＇]', '''', 'g'),
             '[[:space:]　]+', '', 'g'),
           '^["''”“「『]|["''”」』]$', '', 'g')
$$;

create temp view l3 as
with base as (
  select n.id,
         n.title,
         n.audience,
         n.status,
         n.deadline_at,
         -- 摘要是谁写的：`manual` = 人工复核录入（`lib/summary-content.ts` 的 MANUAL_SUMMARY_MODEL）。
         -- 这一列决定重跑时**能不能覆盖**它 —— 人工写的那一份不是模型产出，重跑等于毁掉人的活。
         n.summary_model,
         n.summary_status,
         case when n.ai_summary_json like '{%' then n.ai_summary_json::jsonb end as s,
         case when n.summary_diagnostics_json like '{%' then n.summary_diagnostics_json::jsonb end as d,
         -- 审读记录（issue #47；判读的渲染门只认它）：非数组一律当"没有记录"
         case when n.impact_review_json like '[%' then n.impact_review_json::jsonb end as r
    from notices n
), shaped as (
  select id,
         title,
         audience,
         status,
         deadline_at,
         summary_model,
         summary_status,
         s,
         d,
         -- `r`（审读记录）必须**在这一层带下去**：第 12 节第二段要直接读它数"至少一条已改"。
         -- 2026-10-05 生产实跑踩到过：base 里算了 `r` 而这里没带 ⇒ `l3` 没有这一列，
         -- 那一段当场报 `column "r" does not exist`；而它**前面**的验收数全是绿的，
         -- 只有最后那张"结论分布"表悄悄没了。判据落在 tests/unit/audit-l3-reach-sql.test.mjs。
         r,
         -- 落库的判读条数（键缺席 / 空数组 / JSON null 一律 0）
         case when jsonb_typeof(s -> 'impacts') = 'array'
              then jsonb_array_length(s -> 'impacts') else 0 end                 as impacts,
         case when jsonb_typeof(s -> 'changes') = 'array'
              then jsonb_array_length(s -> 'changes') else 0 end                 as changes,
         case when jsonb_typeof(s -> 'changeTable') = 'object' then 1 else 0 end as has_table,
         -- 喂入清单（v2 才有）：总份数、汉字数、其中**条文侧**几份（role = draft）
         case when jsonb_typeof(d -> 'feed' -> 'sources') = 'array'
              then jsonb_array_length(d -> 'feed' -> 'sources') else 0 end       as fed_count,
         case when jsonb_typeof(d -> 'feed') = 'object'
              then coalesce((d -> 'feed' ->> 'usedCjk')::int, 0) else 0 end      as fed_cjk,
         case when jsonb_typeof(d -> 'feed' -> 'sources') = 'array'
              then (select count(*) from jsonb_array_elements(d -> 'feed' -> 'sources') e
                     where e ->> 'role' = 'draft') else 0 end                    as fed_draft,
         -- 模型吐出 / 真的落库（诊断里那一对，应当与上面的 impacts 相等 —— 不等就是漂移）
         case when jsonb_typeof(d -> 'emitted') = 'object'
              then coalesce((d -> 'emitted' ->> 'impacts')::int, 0) else 0 end   as emitted_impacts,
         case when jsonb_typeof(d -> 'kept') = 'object'
              then coalesce((d -> 'kept' ->> 'impacts')::int, 0) else 0 end      as kept_impacts,
         case when jsonb_typeof(d -> 'dropped') = 'object'
              then coalesce((d -> 'dropped' ->> 'quoteNotFound')::int, 0) else 0 end as dropped_quotes,
         (d is not null)                                                         as has_diag,
         coalesce(d ->> 'v', '')                                                 as diag_v,
         -- 「能不能渲染」（issue #52 的严格门）：判读里**有有效审读记录**的条数。
         -- 有效 = 两个指纹（归一化后）全等、且结论不是剔除（revised 渲染审读后文本、passed 渲染原文）。
         (select count(*)
            from jsonb_array_elements(
                   case when jsonb_typeof(s -> 'impacts') = 'array' then s -> 'impacts' else '[]'::jsonb end) i
           where exists (
                   select 1
                     from jsonb_array_elements(coalesce(r, '[]'::jsonb)) rec
                    where rec ->> 'quoteFingerprint' = pg_temp.zw_fingerprint(i ->> 'quote')
                      and rec ->> 'textFingerprint' = pg_temp.zw_fingerprint(i ->> 'text')
                      and coalesce(rec ->> 'status', '') in ('passed', 'revised')))  as renderable_impacts,
         -- 被审读**剔除**的条数（"审读真的在减"看得见的那一层）
         (select count(*)
            from jsonb_array_elements(
                   case when jsonb_typeof(s -> 'impacts') = 'array' then s -> 'impacts' else '[]'::jsonb end) i
           where exists (
                   select 1
                     from jsonb_array_elements(coalesce(r, '[]'::jsonb)) rec
                    where rec ->> 'quoteFingerprint' = pg_temp.zw_fingerprint(i ->> 'quote')
                      and rec ->> 'textFingerprint' = pg_temp.zw_fingerprint(i ->> 'text')
                      and rec ->> 'status' = 'rejected'))                           as rejected_impacts,
         -- **错挂**的记录：一条记录（两个指纹）匹配不上任何一条判读（#51 的"指纹匹配率 100%"）
         (select count(*)
            from jsonb_array_elements(coalesce(r, '[]'::jsonb)) rec
           where not exists (
                   select 1
                     from jsonb_array_elements(
                            case when jsonb_typeof(s -> 'impacts') = 'array' then s -> 'impacts' else '[]'::jsonb end) i
                    where pg_temp.zw_fingerprint(i ->> 'quote') = rec ->> 'quoteFingerprint'
                      and pg_temp.zw_fingerprint(i ->> 'text') = rec ->> 'textFingerprint'))  as misattached_records,
         -- 展示口径：还没截止（Asia/Shanghai 的当天；截止日为空按"还没截止"）
         coalesce(substr(deadline_at, 1, 10)
                  >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD'), true) as still_open
    from base
)
select * from shaped;

-- 归因分档：**互斥**（见文件头 ②）。优先级 = 处置的先后：先看有没有料可读（a0/a），
-- 再看模型问没问出来（b），再看我们丢没丢（c），最后才看**门放不放行**（ok/e）。
create temp view l3b as
select id, title, audience, status, deadline_at, s, impacts, changes, has_table,
       fed_count, fed_cjk, fed_draft, emitted_impacts, kept_impacts, dropped_quotes,
       has_diag, diag_v, still_open, renderable_impacts, rejected_impacts, misattached_records,
       case
         when s is null then 'z.没有摘要'
         when not has_diag then 'x.没有诊断(无法归因)'
         when diag_v = '1' then 'x2.诊断是v1(没记feed)'
         when fed_count = 0 and emitted_impacts > 0 then 'a0.异常:没喂却吐了判读'
         when fed_count = 0 then 'a.一份都没喂(抓取侧)'
         when emitted_impacts = 0 then 'b.喂了模型没吐(提示词/能力)'
         when impacts = 0 then 'c.吐了被反查全吃(校验器)'
         when renderable_impacts > 0 then 'ok.真的渲染得出来'
         else 'e.有判读但门不放行(没有有效审读记录)'
       end as bucket
  from l3;

\echo ''
\echo '=== 0. 分母的诚实性：诊断列覆盖面（漏斗能拆到哪一层，由这一节决定）==='
select count(*)                                            as "条目总数",
       count(*) filter (where s is not null)                as "有摘要",
       count(*) filter (where has_diag)                     as "有诊断",
       count(*) filter (where s is not null and has_diag)   as "摘要+诊断都有",
       count(*) filter (where s is not null and not has_diag) as "有摘要没诊断(人工录入或旧管线)",
       count(*) filter (where has_diag and diag_v = '1')    as "诊断是v1(没有feed)",
       count(*) filter (where has_diag and diag_v not in ('1', '2', '3')) as "诊断版本认不出"
  from l3;

\echo ''
\echo '=== 1. 全站漏斗（一行看完全程；v1/无诊断的行没有 feed 记录，会落在 ② 之外 —— 见第 0/3 节）==='
select count(*) filter (where s is not null)                                      as "①有摘要",
       count(*) filter (where s is not null and fed_count > 0)                    as "②真喂了东西",
       count(*) filter (where s is not null and fed_draft > 0)                    as "③喂了条文侧",
       count(*) filter (where emitted_impacts > 0)                                as "④模型吐了判读",
       count(*) filter (where impacts > 0)                                        as "⑤落库判读",
       count(*) filter (where renderable_impacts > 0)                             as "⑥门放行(有有效审读记录)",
       count(*) filter (where renderable_impacts > 0 and still_open)              as "⑦其中还没截止"
  from l3;

\echo ''
\echo '=== 2. 受众面 × 漏斗（**受众面已退出判读的渲染判据**；这张表现在只说明产出分布）==='
select coalesce(audience, '(未判定)')                                 as "受众面",
       count(*)                                                       as "条目",
       count(*) filter (where s is not null)                          as "有摘要",
       count(*) filter (where fed_draft > 0)                          as "喂了条文",
       count(*) filter (where emitted_impacts > 0)                    as "吐了判读",
       count(*) filter (where impacts > 0)                            as "落库判读",
       count(*) filter (where renderable_impacts > 0)                 as "其中门放行",
       count(*) filter (where impacts > 0 and still_open)             as "其中未截止",
       round(100.0 * count(*) filter (where impacts > 0)
             / nullif(count(*) filter (where s is not null), 0), 1)   as "判读率%"
  from l3
 group by 1
 order by 2 desc;

\echo ''
\echo '=== 3. 落空在哪一关（互斥分档；各档处置相反，所以逐档分开数）==='
select count(*) filter (where bucket = 'x.没有诊断(无法归因)')            as "x.没有诊断(量具不存在)",
       count(*) filter (where bucket = 'x2.诊断是v1(没记feed)')           as "x2.诊断是v1(没记feed)",
       count(*) filter (where bucket = 'a0.异常:没喂却吐了判读')           as "a0.异常(没喂却吐了判读)",
       count(*) filter (where bucket = 'a.一份都没喂(抓取侧)')             as "a.一份都没喂(抓取侧)",
       count(*) filter (where bucket = 'b.喂了模型没吐(提示词/能力)')      as "b.喂了模型没吐(提示词/能力)",
       count(*) filter (where bucket = 'c.吐了被反查全吃(校验器)')         as "c.吐了被反查全吃(校验器)",
       count(*) filter (where bucket = 'e.有判读但门不放行(没有有效审读记录)') as "e.有判读但门不放行(缺审读记录)",
       count(*) filter (where bucket = 'ok.真的渲染得出来')                as "ok.真的渲染得出来"
  from l3b
 where s is not null;

\echo '   自检：上面八档之和必须等于「有摘要」（不等就是分档重叠或漏行）'
select (select count(*) from l3 where s is not null) as "有摘要",
       count(*)                                      as "分档合计",
       (select count(*) from l3 where s is not null) - count(*) as "差额(必须是0)"
  from l3b
 where s is not null;

\echo ''
\echo '=== 3b. 同上，但只看「还没截止」的条目（今天真正动得了的那一批）==='
select count(*) filter (where bucket = 'x.没有诊断(无法归因)')            as "x.没有诊断",
       count(*) filter (where bucket = 'x2.诊断是v1(没记feed)')           as "x2.诊断是v1",
       count(*) filter (where bucket = 'a0.异常:没喂却吐了判读')           as "a0.异常",
       count(*) filter (where bucket = 'a.一份都没喂(抓取侧)')             as "a.一份都没喂",
       count(*) filter (where bucket = 'b.喂了模型没吐(提示词/能力)')      as "b.喂了模型没吐",
       count(*) filter (where bucket = 'c.吐了被反查全吃(校验器)')         as "c.被反查全吃",
       count(*) filter (where bucket = 'e.有判读但门不放行(没有有效审读记录)') as "e.有判读但门不放行",
       count(*) filter (where bucket = 'ok.真的渲染得出来')                as "ok.渲染得出来"
  from l3b
 where s is not null and still_open;

\echo ''
\echo '=== 4. a / b / c 档点名：真正需要动手的少数几条（抓取侧 / 提示词 / 校验器）==='
select split_part(bucket, '.', 1) as "档", id, coalesce(audience, '(未判定)') as "受众面",
       status as "库内状态", deadline_at as "截止",
       fed_count as "喂入份数", fed_cjk as "喂入汉字", emitted_impacts as "吐出",
       impacts as "落库", dropped_quotes as "反查丢", left(title, 40) as "标题"
  from l3b
 where bucket in ('a0.异常:没喂却吐了判读', 'a.一份都没喂(抓取侧)',
                   'b.喂了模型没吐(提示词/能力)', 'c.吐了被反查全吃(校验器)')
 order by 1, still_open desc, id;

\echo ''
\echo '=== 5. e 档点名：**有判读、门却不放行**（一条有效审读记录都没有）—— 回填要补的就是这些 ==='
\echo '   #52 之后门只认审读记录，所以这一节就是"开门那一刻会空掉的条目"的全部名单。'
\echo '   处置：scripts/review-impacts-now.mjs（只审读不重跑）补记录，或重跑该条目。'
select id, coalesce(audience, '(未判定)') as "受众面", status as "库内状态",
       deadline_at as "截止", impacts as "判读条数", fed_draft as "喂入条文份数",
       left(title, 46) as "标题"
  from l3
 where impacts > 0 and renderable_impacts = 0
 order by still_open desc, impacts desc, deadline_at nulls last;

\echo ''
\echo '=== 6. 真渲染得出来的那些（读者今天能看见的全部判读）==='
select id, coalesce(audience, '(未判定)') as "受众面", status as "库内状态", deadline_at as "截止",
       impacts as "判读条数", renderable_impacts as "门放行条数", rejected_impacts as "被剔除条数",
       fed_draft as "喂入条文份数", left(title, 46) as "标题"
  from l3
 where impacts > 0 and renderable_impacts > 0
 order by still_open desc, renderable_impacts desc, deadline_at nulls last;

\echo ''
\echo '=== 7. 判读的条数分布与类型分布（只统计真落库的那些）==='
select impacts as "每条判读条数", count(*) as "条目数"
  from l3 where impacts > 0
 group by 1 order by 1;

\echo ''
select e ->> 'kind' as "类型", count(*) as "条数"
  from l3,
       jsonb_array_elements(case when jsonb_typeof(s -> 'impacts') = 'array'
                                 then s -> 'impacts' else '[]'::jsonb end) as e
 where impacts > 0
 group by 1
 order by 2 desc;

\echo ''
\echo '=== 8. 自检：没有诊断的那些里到底有没有判读？==='
\echo '   若"无诊断但有判读"= 0，则第 3 节 x 档那 80 条是"判读这一层还不存在时生成的"，'
\echo '   而不是"模型没想到影响" —— 这两句话的处置完全相反（重跑 vs 改提示词）。'
select count(*) filter (where not has_diag and s is not null)          as "无诊断但有摘要",
       count(*) filter (where not has_diag and impacts > 0)            as "无诊断但有判读",
       count(*) filter (where not has_diag and s ? 'impacts')          as "无诊断但摘要里带impacts键",
       count(*) filter (where not has_diag and changes > 0)            as "无诊断但有改动对照",
       count(*) filter (where not has_diag and has_table > 0)          as "无诊断但有改动表"
  from l3;

\echo ''
\echo '=== 9. 重跑杠杆的真实边界（**旧判据**的口径，留作与 87 号文档 §9.5 对读）==='
\echo '   「已带上可核对的条文要点」= keyPoints 里有一项带 source，那曾是那个工具的幂等过滤'
\echo '   （alreadyHasDraftPoints，写于 issue #67，当时的缺口是**条文要点**）。'
\echo '   2026-10-04（issue #48）起工具的判据换成「缺 L2/L3 就算候选」，落点是'
\echo '   src/lib/redraft-candidates.ts —— 本节与 9b 量的是**旧判据**，所以第 1 列大不代表'
\echo '   工具还在漏跑；要看新判据的清单请用第 9c 节，或将工具本身当 dry-run 跑一遍。'
select count(*) filter (where not has_diag and s is not null)                     as "无诊断但有摘要",
       count(*) filter (where not has_diag and s is not null
                          and summary_model = 'manual')                           as "其中人工录入(不许覆盖)",
       count(*) filter (where not has_diag and s is not null
                          and exists (select 1 from jsonb_array_elements(
                                        case when jsonb_typeof(s -> 'keyPoints') = 'array'
                                             then s -> 'keyPoints' else '[]'::jsonb end) k
                                       where coalesce(k ->> 'source', '') <> ''))     as "已有带出处条文要点(工具跳过)",
       count(*) filter (where not has_diag and s is not null and still_open
                          and summary_model is distinct from 'manual'
                          and not exists (select 1 from jsonb_array_elements(
                                            case when jsonb_typeof(s -> 'keyPoints') = 'array'
                                                 then s -> 'keyPoints' else '[]'::jsonb end) k
                                           where coalesce(k ->> 'source', '') <> '')) as "其中工具会接手的(未截止/非人工)"
  from l3;

\echo ''
\echo '=== 9b. **旧判据**那一步能捞回多少（口径 = 无诊断 + 未截止 + 非人工 + 已有带出处要点）==='
\echo '   筛选口径 = 无诊断 + 未截止 + 非人工录入 + **已有带出处的条文要点**。'
\echo '   最后一条是关键：它证明这些条目今天**读得到条文** —— 也就是说重跑不是白花一次调用，'
\echo '   而是"材料已在手、只是当初那次调用没问 L2/L3"。'
select id, coalesce(audience, '(未判定)') as "受众面", status as "库内状态",
       deadline_at as "截止",
       (select count(*) from jsonb_array_elements(
          case when jsonb_typeof(s -> 'keyPoints') = 'array'
               then s -> 'keyPoints' else '[]'::jsonb end) k
         where coalesce(k ->> 'source', '') <> '') as "已有条文要点条数",
       left(title, 40) as "标题"
  from l3
 where not has_diag and s is not null and still_open
   and summary_model is distinct from 'manual'
   and exists (select 1 from jsonb_array_elements(
                 case when jsonb_typeof(s -> 'keyPoints') = 'array'
                      then s -> 'keyPoints' else '[]'::jsonb end) k
                where coalesce(k ->> 'source', '') <> '')
 order by deadline_at nulls last;

\echo ''
\echo '=== 9c. 新判据下的清单（与 src/lib/redraft-candidates.ts **同源**）==='
\echo '   「缺 L2/L3」= 摘要 JSON 里**没有 impacts 键或没有 changes 键** —— 键缺席只可能来自'
\echo '   "那次调用的提示词里还没有这一问"；键在而值是空数组是"问过了、模型说没有"，**不算缺**'
\echo '   （这一条正是工具幂等的依据：产不出改动对照的条目不会被反复清空重跑）。'
\echo '   另有两条候选理由 SQL 这一层不表达：缺带出处的条文要点（旧判据）、判读缺 point 键（旧形状）。'
\echo '   而且"能不能真动手"还要过工具的第二步 —— 这条今天**读得到条文**（重跑不是白花一次调用）。'
select id, coalesce(audience, '(未判定)') as "受众面", status as "库内状态",
       deadline_at as "截止",
       (s ? 'impacts') as "问过L3", (s ? 'changes') as "问过L2",
       left(title, 40) as "标题"
  from l3
 where s is not null and still_open
   and summary_model is distinct from 'manual'
   and (not (s ? 'impacts') or not (s ? 'changes'))
 order by deadline_at nulls last;

\echo ''
\echo '=== 10. 摘要的来路（summary_model / summary_status）==='
select coalesce(summary_model, '(null)') as "摘要模型", summary_status as "摘要状态",
       count(*) as "条目数",
       count(*) filter (where has_diag) as "其中有诊断",
       count(*) filter (where impacts > 0) as "其中有判读"
  from l3
 where s is not null
 group by 1, 2
 order by 3 desc;

\echo ''
\echo '=== 11. 自检：诊断里的 kept.impacts 与落库数组长度必须逐条相等（不等就是漂移）==='
select count(*) filter (where kept_impacts <> impacts) as "两者不一致的条目数"
  from l3
 where has_diag and diag_v in ('2', '3');

\echo ''
\echo '=== 12. 审读记录覆盖面（issue #51 的两个验收数：缺口 0、指纹匹配率 100%）==='
\echo '   · 「缺口」= 有判读、但按门判没有任何一条有有效记录（第 5 节逐条点名）。'
\echo '   · 「错挂」= 一条记录（两个指纹）匹配不上本条目任何一条判读 —— **必须为 0**：'
\echo '     错挂的表现是"一份没人做过的结论挂在别的判读上"，而页面上看不出来。'
select count(*) filter (where impacts > 0)                        as "有判读的条目",
       count(*) filter (where impacts > 0 and renderable_impacts = 0) as "缺口条目(门不放行)",
       count(*) filter (where impacts > 0 and rejected_impacts > 0)   as "有被剔除的条目",
       sum(impacts)                                              as "判读总条数",
       sum(renderable_impacts)                                    as "门放行条数",
       sum(rejected_impacts)                                      as "被剔除条数",
       sum(misattached_records)                                   as "错挂记录数(必须0)"
  from l3;

\echo ''
\echo '   审读结论的分布（按条目数；「三条记录」的条目会同时计入多列，所以这一节不求和）'
select count(*) filter (where renderable_impacts > 0)                 as "至少一条放行",
       count(*) filter (where rejected_impacts > 0)                   as "至少一条剔除",
       count(*) filter (where impacts > 0
                          and exists (select 1 from jsonb_array_elements(coalesce(r, '[]'::jsonb)) rec
                                       where rec ->> 'status' = 'revised')) as "至少一条已改"
  from l3;

\echo ''
\echo '（本脚本除会话级临时视图与一个 pg_temp 函数外不写任何东西：无 insert / update / delete / 表级 ddl。）'
