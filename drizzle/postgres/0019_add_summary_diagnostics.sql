-- 摘要调用的诊断（issue #86 第 0 刀），与 sqlite 侧同结构、同名列、同可空口径。
-- 理由见 drizzle/sqlite/0019_add_summary_diagnostics.sql 与 src/lib/summary-diagnostics.ts。
-- 可空、不回填：存量与人工录入的摘要都没有调用可描述。
ALTER TABLE "notices" ADD COLUMN "summary_diagnostics_json" text;
