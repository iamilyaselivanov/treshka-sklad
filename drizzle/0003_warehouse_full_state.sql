-- Existing v1.6 deployments may already have this exact table because the old
-- route created it at runtime. IF NOT EXISTS lets this one transition migration
-- adopt those databases into the tracked migration history without data loss.
CREATE TABLE IF NOT EXISTS `warehouse_full_state` (
	`state_key` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`item_ids` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
