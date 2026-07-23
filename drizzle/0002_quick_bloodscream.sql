CREATE TABLE `login_throttle` (
	`login` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`blocked_until` text,
	`last_attempt_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `single_owner_idx` ON `users` (`role`) WHERE "users"."role" = 'owner';