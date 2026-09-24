-- 订阅范围与「按发布机关」订阅（issue #60 第 2 刀），与 sqlite 侧同结构
ALTER TABLE "subscriptions" ADD COLUMN "agencies_json" text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scope" text NOT NULL DEFAULT 'rules';
