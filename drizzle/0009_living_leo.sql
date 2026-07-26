CREATE TABLE `warehouse_state_revisions` (
	`state_key` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`state_key`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `warehouse_state_revisions_updated_idx` ON `warehouse_state_revisions` (`updated_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `warehouse_state_revisions`
  (`state_key`, `revision`, `payload`, `updated_at`, `updated_by`)
SELECT `state_key`, `revision`, `payload`, `updated_at`, `updated_by`
FROM `warehouse_full_state`;
