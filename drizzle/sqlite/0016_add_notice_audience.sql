-- 受众面（issue #83）：这条公示"该谁来看、该谁去提意见" ——
-- public 公众广域（立法 / 税收 / 社保医保等，影响不特定多数人）/
-- sector 行业专业（技术标准、行业规程、许可准入，读者以从业者为主）/ unknown 未判定。
--
-- 为什么落列而不是渲染时现算：列表页要**按它筛选并分页**（`?audience=public`），
-- 筛选与计数走的是同一条 SQL；现算只能在应用层把整库拉出来再过滤，与"统计页数字可钻取、
-- 点进去条数一致"这条不变式（issue #36）合不上。
--
-- 与领域标签 category_tags_json 正交：领域答"关于什么事"，受众面答"谁该看"。
-- 判据与优先级见 src/lib/audience.ts；存量由 scripts/tag-notice-audience.mjs 回填。
-- NULL = 本列上线前的存量、没判定过（'unknown' 才是"判过了但没线索"）。
ALTER TABLE `notices` ADD `audience` text;--> statement-breakpoint
ALTER TABLE `notices` ADD `audience_basis` text;
