-- 0011 narrowed the drawing hash index to (organization, property, level, sha256).
-- Reading the catalog showed that set is already enforced, more strictly, by
-- `floor_plans_property_level_uq`: one plan per property per level, whatever the
-- file. So the sha index could only ever fire where the other one already did.
--
-- Worse, the org-wide version it replaced said something untrue: that a given
-- PDF belongs to one place in the portfolio. A compound's two identical blocks,
-- and the same stamped drawing issued twice, are ordinary. Duplicate detection
-- belongs in the upload path as a *warning* ("this file was already used for
-- X"), not in the schema as a refusal.
--
-- Corrected forward: 0011 stays as applied, this closes it out.

DROP INDEX IF EXISTS floor_plans_sha_uq;
