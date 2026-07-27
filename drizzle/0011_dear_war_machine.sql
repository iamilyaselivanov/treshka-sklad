CREATE TABLE `inventory_act_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`payload` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_callsign` text NOT NULL,
	`actor_role` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_act_archive_number_unique` ON `inventory_act_archive` (`number`);--> statement-breakpoint
CREATE INDEX `inventory_act_archive_finished_idx` ON `inventory_act_archive` (`finished_at`);--> statement-breakpoint
CREATE INDEX `inventory_act_archive_actor_idx` ON `inventory_act_archive` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `inventory_act_counters` (
	`scope` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
