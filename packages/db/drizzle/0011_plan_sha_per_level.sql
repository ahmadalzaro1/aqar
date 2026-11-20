-- 0010 made a drawing unique per organization. Real use found the flaw within the
-- hour: floors 2 and 3 of one building are drawn once and issued twice, and two
-- buildings in a compound genuinely can share an identical shell. The claim worth
-- enforcing is narrower — one drawing per *level of one property*, never two.
--
-- Corrected forward, as always: 0010 stays as applied.

DROP INDEX IF EXISTS floor_plans_sha_uq;

CREATE UNIQUE INDEX IF NOT EXISTS floor_plans_sha_uq
  ON floor_plans (organization_id, property_id, level, sha256)
  WHERE sha256 IS NOT NULL;
