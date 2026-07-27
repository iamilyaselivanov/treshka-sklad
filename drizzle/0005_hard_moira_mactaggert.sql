ALTER TABLE `push_deliveries` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `warehouse_full_state` ADD `item_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `warehouse_full_state`
SET `item_ids` = CASE
  WHEN json_valid(`payload`) THEN COALESCE(
    (
      SELECT json_group_array(json_extract(item_entry.value, '$.id'))
      FROM json_each(`warehouse_full_state`.`payload`, '$.items') AS item_entry
      WHERE item_entry.type = 'object'
        AND TRIM(CAST(json_extract(item_entry.value, '$.id') AS TEXT)) <> ''
    ),
    '[]'
  )
  ELSE '[]'
END;
