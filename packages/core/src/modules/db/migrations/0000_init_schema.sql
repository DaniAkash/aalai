CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`station` text NOT NULL,
	`status` text NOT NULL,
	`outcome_path` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `cursor` (
	`repo` text PRIMARY KEY NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`artifact_path` text,
	`artifact_version` text,
	`opened_at` text DEFAULT (current_timestamp) NOT NULL,
	`answered_at` text,
	`answered_by` text,
	`answered_on` text,
	`decision` text,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `machine_snapshots` (
	`run_id` text PRIMARY KEY NOT NULL,
	`machine` text NOT NULL,
	`snapshot_path` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`repo` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_number` integer NOT NULL,
	`status` text NOT NULL,
	`branch` text,
	`pr_url` text,
	`error` text,
	`lease` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`finished_at` text,
	PRIMARY KEY(`repo`, `subject_kind`, `subject_number`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `station_sessions` (
	`run_id` text NOT NULL,
	`station` text NOT NULL,
	`session_key` text NOT NULL,
	`acpx_session_id` text,
	`acpx_record_id` text,
	`agent_session_id` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	PRIMARY KEY(`run_id`, `station`)
);
--> statement-breakpoint
CREATE TABLE `watched_repos` (
	`repo` text PRIMARY KEY NOT NULL,
	`require_label` text,
	`policy` text,
	`paused` integer DEFAULT false NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`added_at` text DEFAULT (current_timestamp) NOT NULL
);
