CREATE TABLE `notices` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`agency` text NOT NULL,
	`url` text NOT NULL,
	`published_at` text,
	`deadline_at` text,
	`status` text DEFAULT 'open' NOT NULL,
	`category_tags_json` text DEFAULT '[]' NOT NULL,
	`body_text` text,
	`ai_summary_json` text,
	`summary_model` text,
	`fetched_at` text NOT NULL,
	`outbound_clicks` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notices_url_unique` ON `notices` (`url`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter_type` text NOT NULL,
	`schedule_config_json` text DEFAULT '{}' NOT NULL,
	`healthy` integer DEFAULT 1 NOT NULL,
	`last_success_at` text
);
