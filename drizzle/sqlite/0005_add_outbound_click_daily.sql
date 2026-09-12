CREATE TABLE `outbound_click_daily` (
	`notice_id` text NOT NULL,
	`click_date` text NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`notice_id`, `click_date`),
	FOREIGN KEY (`notice_id`) REFERENCES `notices`(`id`) ON UPDATE no action ON DELETE no action
);
