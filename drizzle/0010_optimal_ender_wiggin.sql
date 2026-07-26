ALTER TABLE `warehouse_state_revisions` ADD `size_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `warehouse_state_revisions` ADD `archived_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `warehouse_state_revisions`
SET `size_bytes` = length(`payload`),
    `archived_at` = `updated_at`
WHERE `size_bytes` = 0 OR `archived_at` = '';--> statement-breakpoint
CREATE INDEX `warehouse_state_revisions_archived_idx` ON `warehouse_state_revisions` (`archived_at`);
