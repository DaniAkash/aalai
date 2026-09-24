ALTER TABLE `gates` ADD `status` text DEFAULT 'open' NOT NULL;--> statement-breakpoint
CREATE INDEX `gates_status_opened_idx` ON `gates` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `gates_run_idx` ON `gates` (`run_id`);