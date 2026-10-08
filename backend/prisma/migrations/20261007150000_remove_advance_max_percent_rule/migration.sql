-- F-04: advances have NO business limit. The "advance_max_percent" rule (max % of basic salary per advance /
-- per grid total) is removed together with its enforcement in routes/advances.js and routes/payroll.js.
-- Deleting the row (and its rule audit trail) keeps a dead, misleading limit from staying on the Rules page of an
-- already-installed database. Advance rows and payroll amounts are NOT touched. Idempotent.
DELETE FROM `rule_audits` WHERE `ruleKey` = 'advance_max_percent';
DELETE FROM `rules` WHERE `key` = 'advance_max_percent';
