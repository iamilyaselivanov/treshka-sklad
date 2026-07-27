CREATE TABLE `warehouse_state_inventory_acts` (
	`state_key` text NOT NULL,
	`act_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_state_inventory_acts_key_idx` ON `warehouse_state_inventory_acts` (`state_key`,`act_id`);--> statement-breakpoint
CREATE INDEX `warehouse_state_inventory_acts_state_idx` ON `warehouse_state_inventory_acts` (`state_key`);--> statement-breakpoint
INSERT OR IGNORE INTO `warehouse_state_inventory_acts` (`state_key`, `act_id`)
SELECT warehouse_full_state.state_key,
       TRIM(CAST(json_extract(value, '$.id') AS TEXT))
FROM warehouse_full_state,
     json_each(warehouse_full_state.payload, '$.inventoryActs')
WHERE warehouse_full_state.state_key = 'main'
  AND TRIM(CAST(json_extract(value, '$.id') AS TEXT)) <> '';--> statement-breakpoint
ALTER TABLE `warehouse_state_revisions` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `warehouse_state_revisions` ADD `reason` text DEFAULT 'sample' NOT NULL;
