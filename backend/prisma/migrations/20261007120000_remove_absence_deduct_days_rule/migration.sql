-- P2-05 (decision R3): the "absence_deduct_days" rule is obsolete and removed.
-- An absent day nobody classified is a fixed 1-day "with permission" absence (utils/absencePolicy.js); no engine,
-- validator or screen reads this rule any more. Deleting the row (and its audit trail) keeps it from reappearing
-- on the Rules page of an already-installed database. Idempotent: a no-op when the row does not exist.
DELETE FROM `rule_audits` WHERE `ruleKey` = 'absence_deduct_days';
DELETE FROM `rules` WHERE `key` = 'absence_deduct_days';
