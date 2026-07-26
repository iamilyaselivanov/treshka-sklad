CREATE TRIGGER `users_assignment_key_after_insert`
AFTER INSERT ON `users`
BEGIN
  UPDATE `users`
  SET `assignment_key` = replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(trim(replace(replace(replace(replace(replace(replace(
        coalesce(NEW.assignment, ''),
        char(9), ' '), char(10), ' '), char(11), ' '),
        char(12), ' '), char(13), ' '), char(160), ' '))),
      'А','а'),'Б','б'),'В','в'),'Г','г'),'Д','д'),'Е','е'),'Ё','ё'),'Ж','ж'),
      'З','з'),'И','и'),'Й','й'),'К','к'),'Л','л'),'М','м'),'Н','н'),'О','о'),
      'П','п'),'Р','р'),'С','с'),'Т','т'),'У','у'),'Ф','ф'),'Х','х'),'Ц','ц'),
      'Ч','ч'),'Ш','ш'),'Щ','щ'),'Ъ','ъ'),'Ы','ы'),'Ь','ь'),'Э','э'),'Ю','ю'),'Я','я'),
    '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '),
    '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `users_assignment_key_after_assignment_update`
AFTER UPDATE OF `assignment` ON `users`
BEGIN
  UPDATE `users`
  SET `assignment_key` = replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(trim(replace(replace(replace(replace(replace(replace(
        coalesce(NEW.assignment, ''),
        char(9), ' '), char(10), ' '), char(11), ' '),
        char(12), ' '), char(13), ' '), char(160), ' '))),
      'А','а'),'Б','б'),'В','в'),'Г','г'),'Д','д'),'Е','е'),'Ё','ё'),'Ж','ж'),
      'З','з'),'И','и'),'Й','й'),'К','к'),'Л','л'),'М','м'),'Н','н'),'О','о'),
      'П','п'),'Р','р'),'С','с'),'Т','т'),'У','у'),'Ф','ф'),'Х','х'),'Ц','ц'),
      'Ч','ч'),'Ш','ш'),'Щ','щ'),'Ъ','ъ'),'Ы','ы'),'Ь','ь'),'Э','э'),'Ю','ю'),'Я','я'),
    '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '),
    '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- Recalculate every legacy row through the same trigger used by future writes.
UPDATE `users` SET `assignment` = `assignment`;
