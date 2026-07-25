-- Some v1.6 deployments created these tables before Drizzle recorded this
-- migration. Every statement is idempotent so the migration can adopt those
-- databases without dropping delivery history or failing the deployment.
CREATE TABLE IF NOT EXISTS `push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`attempted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `push_deliveries_event_device_idx` ON `push_deliveries` (`event_id`,`device_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_deliveries_status_idx` ON `push_deliveries` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token` text NOT NULL,
	`platform` text DEFAULT 'android' NOT NULL,
	`app_version` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `push_devices_device_idx` ON `push_devices` (`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `push_devices_token_idx` ON `push_devices` (`token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_devices_user_idx` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`post` text DEFAULT '' NOT NULL,
	`entity_no` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_events_created_idx` ON `push_events` (`created_at`);
