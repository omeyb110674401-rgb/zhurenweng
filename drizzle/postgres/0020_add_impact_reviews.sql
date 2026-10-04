-- 审读记录（issue #47），与 sqlite 侧同结构、同名列、同可空口径。
-- 理由见 drizzle/sqlite/0020_add_impact_reviews.sql 与 src/lib/impact-review.ts。
-- 可空、不回填：存量、人工录入的摘要、以及审读没跑过的条目都是 NULL。
ALTER TABLE "notices" ADD COLUMN "impact_review_json" text;
