CREATE TABLE IF NOT EXISTS `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sku` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`unit` text DEFAULT 'шт' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`minimum` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `products_sku_unique` ON `products` (`sku`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_name_idx` ON `products` (`name`);