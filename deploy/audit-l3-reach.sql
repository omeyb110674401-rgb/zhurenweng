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
--   · 「能不能渲染」= `shouldRenderImpacts` 的两条判据（`audience = 'public'` 且非空），
--     与列表页标记（`notice-marks.ts`）**同源** —— 这里只是把它翻成 SQL，不重写它。
--   · 「还没截止」用展示口径（`effectiveStatus`）：库内 `status` 是抓取时推导的，刚过截止的
--     条目能挂十几个小时仍是 `open`（见 `notice-status.ts` 头注的生产实测）⇒ 两列都看，
--     并按 **Asia/Shanghai** 的当天比较（库容器是 UTC，`now()::date` 会在北京时间 0–8 点差一天）；
--     截止日为空时按"还没截止"算 —— 与 `effectiveStatus` 的 `days === null ⇒ open` 一致。
--
-- 跑法（**不写库、不碰 /opt**）：
--   cat deploy/audit-l3-reach.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng
-- 迁移 0019 之前会报 `column "summary_diagnostics_json" does not exist`，那是预期。
--
-- 唯一"写"的东西是两个 **TEMPORARY VIEW**：只活在这个 psql 会话里、断开即消失，
-- 对库不留任何痕迹。用它们的理由是不必把上面那四十行口径在十个小节里抄十遍 ——
-- 抄十遍的那一份，迟早有几处走样，而这类脚本一旦两节口径不一致，
-- 读的人不会怀疑脚本，会怀疑数据。
--
-- 结构上有两处**不是风格问题**：
--   ① `s` / `d` 必须在 `base` 这一层就物化成列，不能在同一个 select 列表里往下引用
--      （Postgres 里同一层 select 的别名互不可见，写成一层的直接报 `column "s" does not exist`）。
--   ② 归因分档必须是**一个 `case` 表达式**（互斥），不能是一串 `count(*) filter (...)`
--      —— 后者各档可以重叠，而重叠的表现是**各档之和 > 总数**：本脚本第一版就在 97 行的
--      分母上数出了 98。一个各部分之和大于整体的漏斗，读的人不会发现它错了，
--      只会觉得"数据有点怪"。**看不见的缺口**正是本项目定义缺陷的方式，所以第 3 节
--      自带一条"分档合计 = 总数"的自检。

\pset border 2

create temp view l3 as
with base as (
  select n.id,
         n.title,
         n.audience,
         n.status,
         n.deadline_at,
         -- 摘要是谁写的：`manual` = 人工复核录入（`admin/review/route.ts` 的 MANUAL_SUMMARY_MODEL）。
         -- 这一列决定重跑时**能不能覆盖**它 —— 人工写的那一份不是模型产出，重跑等于毁掉人的活。
         n.summary_model,
         n.summary_status,
         case when n.ai_summary_json like '{%' then n.ai_summary_json::jsonb end as s,
         case when n.summary_diagnostics_json like '{%' then n.summary_diagnostics_json::jsonb end as d
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
         -- 展示口径：还没截止（Asia/Shanghai 的当天；截止日为空按"还没截止"）
         coalesce(substr(deadline_at, 1, 10)
                  >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD'), true) as still_open
    from base
)
select * from shaped;

-- 归因分档：**互斥**（见文件头 ②）。优先级 = 处置的先后：先看有没有料可读（a0/a），
-- 再看模型问没问出来（b），再看我们丢没丢（c），最后才是产品决定挡不挡（ok/d）。
create temp view l3b as
select id, title, audience, status, deadline_at, s, impacts, changes, has_table,
       fed_count, fed_cjk, fed_draft, emitted_impacts, kept_impacts, dropped_quotes,
       has_diag, diag_v, still_open,
       case
         when s is null then 'z.没有摘要'
         when not has_diag then 'x.没有诊断(无法归因)'
         when diag_v = '1' then 'x2.诊断是v1(没记feed)'
         when fed_count = 0 and emitted_impacts > 0 then 'a0.异常:没喂却吐了判读'
         when fed_count = 0 then 'a.一份都没喂(抓取侧)'
         when emitted_impacts = 0 then 'b.喂了模型没吐(提示词/能力)'
         when impacts = 0 then 'c.吐了被反查全吃(校验器)'
         when audience = 'public' then 'ok.真的渲染得出来'
         else 'd.落库了被受众面挡住(产品决定)'
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
       count(*) filter (where has_diag and diag_v not in ('1', '2')) as "诊断版本认不出"
  from l3;

\echo ''
\echo '=== 1. 全站漏斗（一行看完全程；v1/无诊断的行没有 feed 记录，会落在 ② 之外 —— 见第 0/3 节）==='
select count(*) filter (where s is not null)                                      as "①有摘要",
       count(*) filter (where s is not null and fed_count > 0)                    as "②真喂了东西",
       count(*) filter (where s is not null and fed_draft > 0)                    as "③喂了条文侧",
       count(*) filter (where emitted_impacts > 0)                                as "④模型吐了判读",
       count(*) filter (where impacts > 0)                                        as "⑤落库判读",
       count(*) filter (where impacts > 0 and audience = 'public')                as "⑥公众广域(可渲染)",
       count(*) filter (where impacts > 0 and audience = 'public' and still_open) as "⑦其中还没截止"
  from l3;

\echo ''
\echo '=== 2. 受众面 × 漏斗（这一张表就是「要不要扩到行业专业档」的全部分母）==='
select coalesce(audience, '(未判定)')                                 as "受众面",
       count(*)                                                       as "条目",
       count(*) filter (where s is not null)                          as "有摘要",
       count(*) filter (where fed_draft > 0)                          as "喂了条文",
       count(*) filter (where emitted_impacts > 0)                    as "吐了判读",
       count(*) filter (where impacts > 0)                            as "落库判读",
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
       count(*) filter (where bucket = 'd.落库了被受众面挡住(产品决定)')   as "d.落库了被受众面挡住(产品决定)",
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
       count(*) filter (where bucket = 'd.落库了被受众面挡住(产品决定)')   as "d.被受众面挡住",
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
\echo '=== 5. d 档点名：落库了判读、详情页却一个字都不渲染的（扩档的全部收益）==='
select id, coalesce(audience, '(未判定)') as "受众面", status as "库内状态",
       deadline_at as "截止", impacts as "判读条数", left(title, 46) as "标题"
  from l3
 where impacts > 0 and audience <> 'public'
 order by impacts desc, deadline_at nulls last;

\echo ''
\echo '=== 6. 真渲染得出来的那些（读者今天能看见的全部判读）==='
select id, audience as "受众面", status as "库内状态", deadline_at as "截止",
       impacts as "判读条数", fed_draft as "喂入条文份数", left(title, 46) as "标题"
  from l3
 where impacts > 0 and audience = 'public'
 order by still_open desc, impacts desc, deadline_at nulls last;

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
 where has_diag and diag_v = '2';

\echo ''
\echo '（本脚本除会话级临时视图外不写任何东西：无 insert / update / delete / ddl。）'
