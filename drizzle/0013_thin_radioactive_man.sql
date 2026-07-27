DROP TABLE `inventory_act_counters`;--> statement-breakpoint
ALTER TABLE `warehouse_state_inventory_acts` ADD `header_json` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `warehouse_state_inventory_acts`
SET `header_json` = COALESCE((
  SELECT json(entry.value)
  FROM `warehouse_full_state` AS warehouse,
       json_each(warehouse.payload, '$.inventoryActs') AS entry
  WHERE warehouse.state_key = `warehouse_state_inventory_acts`.`state_key`
    AND entry.type = 'object'
    AND TRIM(CAST(json_extract(entry.value, '$.id') AS TEXT))
      = `warehouse_state_inventory_acts`.`act_id`
  LIMIT 1
), '');
