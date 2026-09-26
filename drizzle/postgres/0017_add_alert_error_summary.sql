-- 告警留痕（issue #83）：与 sqlite 侧同结构、同名列，可空。
-- 存量行保持 NULL（那时没记录），不回填、不猜。
ALTER TABLE "alert_sends" ADD COLUMN "error_summary" text;
