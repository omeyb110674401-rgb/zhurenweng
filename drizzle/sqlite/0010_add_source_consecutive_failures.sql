-- 本仓库第一条「迁移里带数据写入」。播种不是可选的：不播种则一个正红着的源在下轮失败时被
-- 算成「连续第 1 次」，按门槛判健康 —— 一个真挂着的源会静默转绿且不发信。
-- healthy=0 的行因此从门槛起步，下一次失败即第 2 次（照常转红、照常发信）。
ALTER TABLE `sources` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sources` SET `consecutive_failures` = 2 WHERE `healthy` = 0;