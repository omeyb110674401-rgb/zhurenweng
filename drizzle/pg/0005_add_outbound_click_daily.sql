CREATE TABLE "outbound_click_daily" (
	"notice_id" text NOT NULL,
	"click_date" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbound_click_daily_notice_id_click_date_pk" PRIMARY KEY("notice_id","click_date")
);
--> statement-breakpoint
ALTER TABLE "outbound_click_daily" ADD CONSTRAINT "outbound_click_daily_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE no action ON UPDATE no action;