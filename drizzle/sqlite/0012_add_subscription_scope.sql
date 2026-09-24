-- 订阅范围与「按发布机关」订阅（issue #60 第 2 刀）
-- agencies_json：订阅的发布机关（归一后的名字）；匹配时对条目的复合机关串逐个精确相等，
--   不用子串 —— 「司法部」不该命中「司法部办公厅」。
-- scope：'rules'（默认，按关键词 / 领域 / 机关）| 'all'（收录的全部新公示）。
--   为什么单独一列、而不是「规则全空就当订全部」：空规则更可能是漏填。把漏填静默解释成
--   「订全部」，用户是在收到一堆邮件之后才发现自己没设过条件 —— 订阅范围必须是显式选出来的。
ALTER TABLE `subscriptions` ADD `agencies_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `scope` text NOT NULL DEFAULT 'rules';
