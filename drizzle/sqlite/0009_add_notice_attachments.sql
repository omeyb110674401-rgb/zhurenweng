CREATE TABLE `notice_attachments` (
	`notice_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text,
	`status` text NOT NULL,
	`kind` text,
	`bytes` integer,
	`content_hash` text,
	`char_count` integer,
	`extracted_text` text,
	`error` text,
	`fed_to_summary` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_fetch_at` text,
	PRIMARY KEY(`notice_id`, `url`),
	FOREIGN KEY (`notice_id`) REFERENCES `notices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notice_attachments_status_idx` ON `notice_attachments` (`status`,`notice_id`);
