-- 体裁判定（issue #76）：同一条"征求意见"公告，修正案要的是"改了哪几处 + 影响"，
-- 新案要的是"每章每条规定了什么"。一套提示词服务两种需求，两边都不到位 —— 所以先分体裁。
-- 为什么在入库时算一次并存下来，而不是生成摘要时现推：现推意味着同一批数据在不同时刻
-- 会被分到不同模板，页面、后台与检索三处对不上账。
-- 为什么带 genre_basis / genre_evidence：这个字段决定读者看到什么形态的摘要，判错了要能在
--   后台当场看出是哪条规则撞的（#58 删「调度配置」立的规矩：看不出依据的字段没人敢信）；
--   evidence 用来挡"弱证据覆盖强证据"——抽取任务刚按正文升级的判定，不能被下一轮抓取按标题降回去。
-- NULL = 本列之前的存量没判定过；'unknown' = 判过了但没有线索。两者都显示"未判定"，
--   但只有前者会被回填脚本再扫一遍。
ALTER TABLE `notices` ADD `genre` text;--> statement-breakpoint
ALTER TABLE `notices` ADD `genre_basis` text;--> statement-breakpoint
ALTER TABLE `notices` ADD `genre_evidence` text;
