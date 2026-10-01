ALTER TABLE `runs` ADD `title` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `offered_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `queued_at` text;--> statement-breakpoint
CREATE INDEX `runs_status_queued_at` ON `runs` (`status`,`queued_at`);--> statement-breakpoint
UPDATE `runs` SET `status` = 'running' WHERE `status` = 'claimed';--> statement-breakpoint
UPDATE `runs` SET `queued_at` = `started_at`, `offered_at` = `started_at` WHERE `status` IN ('running', 'blocked');
