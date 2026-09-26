-- 受众面（issue #83）：与 sqlite 侧同结构、同名两列，都可空。
-- NULL = 本列上线前的存量没判定过；'unknown' = 判过了但标题与来源都没线索，两者别混。
ALTER TABLE "notices" ADD COLUMN "audience" text;
--> statement-breakpoint
ALTER TABLE "notices" ADD COLUMN "audience_basis" text;
