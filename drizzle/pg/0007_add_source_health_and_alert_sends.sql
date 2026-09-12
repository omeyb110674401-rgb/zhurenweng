CREATE TABLE "alert_sends" (
	"alert_date" text NOT NULL,
	"job_name" text NOT NULL,
	"source_id" text NOT NULL,
	"sent_at" text NOT NULL,
	CONSTRAINT "alert_sends_alert_date_job_name_source_id_pk" PRIMARY KEY("alert_date","job_name","source_id")
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_error_message" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_error_at" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "enabled" integer DEFAULT 1 NOT NULL;