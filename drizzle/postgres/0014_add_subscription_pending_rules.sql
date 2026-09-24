-- 改订阅也要确认（issue #60 第 4 刀），与 sqlite 侧同结构
ALTER TABLE "subscriptions" ADD COLUMN "pending_rules_json" text;
