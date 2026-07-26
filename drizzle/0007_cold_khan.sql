CREATE TABLE `push_maintenance_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_run_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `assignment_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `users`
SET `assignment_key` = replace(replace(replace(replace(replace(replace(replace(replace(
  replace(replace(replace(replace(replace(replace(replace(replace(
  replace(replace(replace(replace(replace(replace(replace(replace(
  replace(replace(replace(replace(replace(replace(replace(replace(replace(
    lower(trim(`assignment`)),
    'А','а'),'Б','б'),'В','в'),'Г','г'),'Д','д'),'Е','е'),'Ё','ё'),'Ж','ж'),
    'З','з'),'И','и'),'Й','й'),'К','к'),'Л','л'),'М','м'),'Н','н'),'О','о'),
    'П','п'),'Р','р'),'С','с'),'Т','т'),'У','у'),'Ф','ф'),'Х','х'),'Ц','ц'),
    'Ч','ч'),'Ш','ш'),'Щ','щ'),'Ъ','ъ'),'Ы','ы'),'Ь','ь'),'Э','э'),'Ю','ю'),'Я','я');--> statement-breakpoint
UPDATE `users`
SET `assignment_key` = replace(replace(replace(replace(`assignment_key`, '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ');--> statement-breakpoint
CREATE INDEX `users_assignment_key_idx` ON `users` (`assignment_key`);
