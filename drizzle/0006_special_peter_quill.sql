CREATE TABLE IF NOT EXISTS `push_delivery_attempts` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `push_delivery_attempts` (`delivery_id`, `attempts`)
SELECT `id`, 0 FROM `push_deliveries`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `warehouse_state_items` (
	`state_key` text NOT NULL,
	`item_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `warehouse_state_items_key_idx` ON `warehouse_state_items` (`state_key`,`item_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `warehouse_state_items_state_idx` ON `warehouse_state_items` (`state_key`);
--> statement-breakpoint
INSERT OR IGNORE INTO `warehouse_state_items` (`state_key`, `item_id`)
SELECT `warehouse_full_state`.`state_key`,
       TRIM(CAST(json_extract(item_entry.value, '$.id') AS TEXT))
FROM `warehouse_full_state`,
     json_each(
       CASE
         WHEN json_valid(`warehouse_full_state`.`payload`) THEN `warehouse_full_state`.`payload`
         ELSE '{"items":[]}'
       END,
       '$.items'
     ) AS item_entry
WHERE item_entry.type = 'object'
  AND TRIM(CAST(json_extract(item_entry.value, '$.id') AS TEXT)) <> '';
