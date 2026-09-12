CREATE TABLE "notices" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"agency" text NOT NULL,
	"url" text NOT NULL,
	"published_at" text,
	"deadline_at" text,
	"status" text DEFAULT 'open' NOT NULL,
	"category_tags_json" text DEFAULT '[]' NOT NULL,
	"body_text" text,
	"ai_summary_json" text,
	"summary_model" text,
	"fetched_at" text NOT NULL,
	"outbound_clicks" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "notices_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"adapter_type" text NOT NULL,
	"schedule_config_json" text DEFAULT '{}' NOT NULL,
	"healthy" integer DEFAULT 1 NOT NULL,
	"last_success_at" text
);
--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;