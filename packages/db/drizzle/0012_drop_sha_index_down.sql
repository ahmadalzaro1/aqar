CREATE UNIQUE INDEX IF NOT EXISTS floor_plans_sha_uq
  ON floor_plans (organization_id, sha256) WHERE sha256 IS NOT NULL;
