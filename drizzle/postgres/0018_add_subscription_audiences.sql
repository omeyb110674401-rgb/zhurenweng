-- 受众面进订阅规则（issue #84），与 sqlite 侧同结构、同名列、同默认值。
-- 存量行由 DEFAULT '[]' 直接拿到"不限"，无需回填。
ALTER TABLE "subscriptions" ADD COLUMN "audiences_json" text NOT NULL DEFAULT '[]';
