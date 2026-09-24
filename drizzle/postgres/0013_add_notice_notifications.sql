-- 新公示通知（issue #60 第 3 刀），与 sqlite 侧同结构（存量 first_seen_at 留 NULL，不回填）
ALTER TABLE "notices" ADD COLUMN "first_seen_at" text;
--> statement-breakpoint
CREATE TABLE "notice_notifications" (
	"notice_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"sent_at" text NOT NULL,
	CONSTRAINT "notice_notifications_notice_id_subscription_id_pk" PRIMARY KEY("notice_id","subscription_id")
);
