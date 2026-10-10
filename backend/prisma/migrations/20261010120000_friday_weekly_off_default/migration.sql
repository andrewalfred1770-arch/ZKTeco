-- Friday weekly-off policy (2026-10): Friday is the official weekly day off, so a Friday with no punches must be a
-- weekly off (never an absence) and a Friday with punches is overtime. The engine already implements that behaviour
-- behind the global rule `friday_is_weekend`; only its DEFAULT was 'false' (Friday = ordinary workday), which made
-- every un-punched Friday an absence with a payroll deduction. rulesEngine.js / seed-rules.js now default it to 'true';
-- the seed never overwrites a stored value, so this data-only migration carries the new default to databases that
-- were seeded earlier.
--
-- Conservative by design: only the rule row that STILL holds the seeded default 'false' AND that no admin ever edited
-- (no 'updated' audit row) is changed. An admin's explicit choice (any edit recorded on the Rules page) is never
-- touched, and an admin can switch Friday back to "workday + overtime" at any time from Attendance Settings.
-- No schema change. Idempotent: a no-op once the value is 'true' or when the row does not exist.
-- NOTE: previously stored Friday rows keep their old status until attendance is recalculated (Rules -> recalculate).

INSERT INTO `rule_audits` (`ruleId`, `ruleKey`, `action`, `fieldName`, `oldValue`, `newValue`, `changedByName`, `changedAt`)
SELECT r.`id`, r.`key`, 'updated', 'value', 'false', 'true', 'System (Friday weekly-off policy migration)', CURRENT_TIMESTAMP(3)
FROM `rules` r
WHERE r.`key` = 'friday_is_weekend'
  AND r.`value` = 'false'
  AND NOT EXISTS (SELECT 1 FROM `rule_audits` a WHERE a.`ruleId` = r.`id` AND a.`action` = 'updated');

UPDATE `rules` r
SET r.`value` = 'true', r.`updatedAt` = CURRENT_TIMESTAMP(3)
WHERE r.`key` = 'friday_is_weekend'
  AND r.`value` = 'false'
  AND EXISTS (
    SELECT 1 FROM `rule_audits` a
    WHERE a.`ruleId` = r.`id` AND a.`action` = 'updated' AND a.`fieldName` = 'value'
      AND a.`changedByName` = 'System (Friday weekly-off policy migration)'
  );
