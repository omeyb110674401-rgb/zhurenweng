-- 改订阅也要确认（issue #60 第 4 刀，解 FOLLOWUPS #52 挂账）
-- pending_rules_json：已确认订阅者再次提交时，新规则先存这里，**确认后才套用到正式规则列**。
--   在此之前提醒与新公示通知仍按旧规则发。
-- 为什么非要一列：共享密钥模型下"知道某个邮箱"就能重复提交表单静默改写其规则
--   （旧行为在 outcome=confirmed-updated 时连确认邮件都不发）。真正能挡住的不是
--   限流，而是让改动必须经一次确认 —— 只有能读该邮箱的人点得了那个链接。
-- 待套用规则为 NULL = 没有待确认的改动（含存量行：JSON.stringify([]) 之类都不算）。
ALTER TABLE `subscriptions` ADD `pending_rules_json` text;
