-- Fix: Rule.value was VARCHAR(191), too small for late_rules/early_rules
-- tier-array JSON (default 6-tier payload alone is 289 chars). Widen to TEXT.
ALTER TABLE `rules` MODIFY `value` TEXT NOT NULL DEFAULT ('');
