CREATE TABLE IF NOT EXISTS `warehouse_full_state` (
	`state_key` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_created_idx` ON `products` (`created_at`);
