CREATE TABLE "reminder_sends" (
	"notice_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"reminder_stage" text NOT NULL,
	"sent_at" text NOT NULL,
	CONSTRAINT "reminder_sends_notice_id_reminder_stage_subscription_id_pk" PRIMARY KEY("notice_id","reminder_stage","subscription_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"keywords_json" text DEFAULT '[]' NOT NULL,
	"categories_json" text DEFAULT '[]' NOT NULL,
	"confirmed" integer DEFAULT 0 NOT NULL,
	"confirm_token" text NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"confirmed_at" text,
	"unsubscribed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "subscriptions_email_unique" UNIQUE("email"),
	CONSTRAINT "subscriptions_confirm_token_unique" UNIQUE("confirm_token"),
	CONSTRAINT "subscriptions_unsubscribe_token_unique" UNIQUE("unsubscribe_token")
);
--> statement-breakpoint
ALTER TABLE "reminder_sends" ADD CONSTRAINT "reminder_sends_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sends" ADD CONSTRAINT "reminder_sends_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;