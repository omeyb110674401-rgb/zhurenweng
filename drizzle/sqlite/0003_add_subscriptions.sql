CREATE TABLE `reminder_sends` (
	`notice_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`reminder_stage` text NOT NULL,
	`sent_at` text NOT NULL,
	PRIMARY KEY(`notice_id`, `reminder_stage`, `subscription_id`),
	FOREIGN KEY (`notice_id`) REFERENCES `notices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`keywords_json` text DEFAULT '[]' NOT NULL,
	`categories_json` text DEFAULT '[]' NOT NULL,
	`confirmed` integer DEFAULT 0 NOT NULL,
	`confirm_token` text NOT NULL,
	`unsubscribe_token` text NOT NULL,
	`confirmed_at` text,
	`unsubscribed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_email_unique` ON `subscriptions` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_confirm_token_unique` ON `subscriptions` (`confirm_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_unsubscribe_token_unique` ON `subscriptions` (`unsubscribe_token`);