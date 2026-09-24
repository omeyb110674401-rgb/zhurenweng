-- 新公示通知（issue #60 第 3 刀）
-- first_seen_at：只在建行时写入、后续更新永不覆盖。`fetched_at` 每天被抓取覆盖
-- （改标题 / 改截止日期也会刷新它），拿它当"新"的判据就会把三个月前的条目天天重发。
-- 刻意**不回填存量行**：NULL = 本次上线之前就收录了 ⇒ 一律不通知。
--   否则一个老邮箱刚点确认，就会被告知库里全部历史公示 —— 那是把人直接推去退订。
ALTER TABLE `notices` ADD `first_seen_at` text;
--> statement-breakpoint
-- 通知去重：复合主键（条目 × 订阅）保证同一条新公示对同一订阅者只进一次汇总邮件。
-- 与 reminder_sends 同构：一封汇总邮件为其中每条公示各写一行，下一轮因此跳过它们。
CREATE TABLE `notice_notifications` (
	`notice_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`sent_at` text NOT NULL,
	PRIMARY KEY(`notice_id`, `subscription_id`),
	FOREIGN KEY (`notice_id`) REFERENCES `notices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
