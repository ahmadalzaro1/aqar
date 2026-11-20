-- 0003_agent_actions: two tables that make agent intent a first-class record.
--
--  1. `action_proposals` — the ONLY way an agent (Hermes, in-app assistant, any
--     MCP client) can request a money-moving or vendor-committing action. A
--     proposal is a row, not a side effect: it commits nothing, contacts nobody,
--     and expires. A human approves it in the console; a separate server job
--     executes it. The model cannot call the executor.
--
--     `args_hash` + the partial unique index mean the same intent cannot pile up
--     as ten identical pending rows when an agent retries or a webhook replays.
--
--  2. `payment_promises` — a tenant saying "I'll pay on the 20th". Previously
--     this only existed as free text inside a ticket message, which is not
--     something a collection workflow can act on.
--
-- Both are tenant-scoped: FORCE row level security, same policy name and helper
-- as 0002_guards so a single mental model covers every table.

-- ---------------------------------------------------------------------------
-- 1. action_proposals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Which tool asked. Kept as text (not an enum) so a new MCP tool needs no DDL.
  tool_name text NOT NULL,
  -- PolicyAction vocabulary from @aqar/contracts (post_payment, create_charge, ...)
  action text NOT NULL,
  args jsonb NOT NULL,
  -- sha256 of the canonicalized args: dedupe key for retries and replays.
  args_hash text NOT NULL,
  -- Human-readable one-liner rendered in the approval queue.
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  -- {kind: 'agent'|'user'|'system', id, name, model, promptVersion}
  requested_by jsonb NOT NULL,
  model_id text,
  idempotency_key text,
  expires_at timestamptz NOT NULL,
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live proposal per identical intent. Approved/rejected rows accumulate as
-- history, so the hash may repeat once the previous one is settled.
CREATE UNIQUE INDEX IF NOT EXISTS action_proposals_pending_uniq
  ON action_proposals (organization_id, args_hash)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS action_proposals_org_status_idx
  ON action_proposals (organization_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. payment_promises
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lease_id uuid REFERENCES leases(id) ON DELETE SET NULL,
  amount_fils integer NOT NULL CHECK (amount_fils > 0),
  promised_date date NOT NULL,
  source_channel identity_channel NOT NULL DEFAULT 'in_app',
  note text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'kept', 'broken', 'cancelled')),
  created_by jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_promises_open_idx
  ON payment_promises (organization_id, promised_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS payment_promises_tenant_idx
  ON payment_promises (organization_id, tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Tenant isolation + grants (mirrors 0002_guards; the 0002 loop only saw the
--    tables that existed when it ran, so new tables declare their own).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['action_proposals', 'payment_promises']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      'USING (organization_id = app.current_org_id()) '
      'WITH CHECK (organization_id = app.current_org_id())',
      t
    );
    -- updated_at maintenance (the 0002 loop only covered pre-existing tables)
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
      t
    );
  END LOOP;
END;
$$;

-- No DELETE: a proposal is history the moment it is written.
GRANT SELECT, INSERT, UPDATE ON action_proposals TO aqar_app;
GRANT SELECT, INSERT, UPDATE ON payment_promises TO aqar_app;
