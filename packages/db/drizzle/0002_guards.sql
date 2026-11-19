-- 0002_guards: database-enforced invariants that cannot live in the ORM schema.
--
--  1. Tenant isolation via FORCE row level security on every tenant-scoped table
--  2. Append-only audit trail (no UPDATE / DELETE, ever)
--  3. Journal balance when an entry is posted
--  4. Period locks reject writes into a closed period
--  5. Emergency flag is sticky (can be raised, never cleared)
--  6. updated_at maintenance
--
-- The application role is `aqar_app` (NOSUPERUSER, NOBYPASSRLS). The superuser
-- `aqar` is used only for migrations and test fixtures. Dev-only credentials.
--
-- NOTE ON THE APP ROLE: it is a CLUSTER-level object, so a per-database down
-- migration deliberately does NOT drop it (rolling back `aqar` must not break
-- `aqar_test`).

-- ---------------------------------------------------------------------------
-- Helper functions (schema `app`, so they never collide with app tables)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;

/**
 * Organization scope for the current connection/transaction:
 *   SELECT set_config('app.organization_id', '<uuid>', true);
 * Returns NULL when unset or malformed — policies then match nothing (fail closed).
 */
CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw := current_setting('app.organization_id', true);
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN raw::uuid;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$;

/** True only when the auth service explicitly opts a statement into cross-org lookup. */
CREATE OR REPLACE FUNCTION app.in_auth_scope() RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(current_setting('app.system_scope', true) = 'auth', false);
$$;

/** 5. sticky emergency flag */
CREATE OR REPLACE FUNCTION app.assert_emergency_sticky() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.emergency_flag AND NOT NEW.emergency_flag THEN
    RAISE EXCEPTION
      'ticket % already flagged emergency; emergency_flag is sticky and cannot be cleared',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

/** 2. audit trail is append-only */
CREATE OR REPLACE FUNCTION app.assert_audit_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only: % is not permitted (insert a reversal row with reversal_of instead)',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

/** 3. a posted journal entry must balance and have at least two lines */
CREATE OR REPLACE FUNCTION app.assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total_debit bigint;
  total_credit bigint;
  line_count integer;
BEGIN
  IF NOT NEW.posted THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(debit_fils), 0),
         coalesce(sum(credit_fils), 0),
         count(*)
    INTO total_debit, total_credit, line_count
    FROM journal_lines
   WHERE entry_id = NEW.id;

  IF line_count < 2 THEN
    RAISE EXCEPTION
      'journal entry % cannot be posted with % line(s); at least 2 are required',
      NEW.id, line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced: debit=% credit=% (fils)',
      NEW.id, total_debit, total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

/** 3b. lines of a posted entry are frozen */
CREATE OR REPLACE FUNCTION app.assert_entry_mutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_posted boolean;
  new_posted boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT posted INTO old_posted FROM journal_entries WHERE id = OLD.entry_id;
    IF old_posted THEN
      RAISE EXCEPTION 'journal entry % is posted; its lines are immutable', OLD.entry_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP IN ('UPDATE', 'INSERT') THEN
    SELECT posted INTO new_posted FROM journal_entries WHERE id = NEW.entry_id;
    IF new_posted THEN
      RAISE EXCEPTION 'journal entry % is posted; its lines are immutable', NEW.entry_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

/** 4. reject writes whose period is locked for the organization */
CREATE OR REPLACE FUNCTION app.assert_period_open() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_period text;
BEGIN
  -- payments has no `period` column: derive it from the human-confirmed
  -- reference_period, else the receipt month. Accessing NEW.period on a
  -- payments row would raise "record new has no field period".
  IF tg_table_name = 'payments' THEN
    target_period := coalesce(NEW.reference_period, to_char(NEW.received_date, 'YYYY-MM'));
  ELSE
    target_period := NEW.period;
  END IF;

  IF target_period IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM period_locks pl
     WHERE pl.organization_id = NEW.organization_id
       AND pl.period = target_period
  ) THEN
    RAISE EXCEPTION
      'period % is locked for organization %; no writes are accepted',
      target_period, NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

/** 6. updated_at maintenance */
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Application role (dev-only credentials, documented in README)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqar_app') THEN
    CREATE ROLE aqar_app LOGIN PASSWORD 'aqar_app_dev'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE aqar_app LOGIN PASSWORD 'aqar_app_dev'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO aqar_app;
GRANT USAGE ON SCHEMA app TO aqar_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aqar_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aqar_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aqar_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aqar_app;

-- defense in depth: the app role has no DML privileges on the audit trail at all
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM aqar_app;
GRANT SELECT, INSERT ON audit_events TO aqar_app;

-- ---------------------------------------------------------------------------
-- 1. Row level security
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    -- M1
    'properties', 'buildings', 'units', 'amenities', 'unit_amenities', 'meters',
    -- M2
    'listings', 'inquiries', 'showings', 'applicants', 'applications',
    'screening_results', 'decisions',
    -- M3
    'tenants', 'leases', 'lease_tenants', 'lease_addendums', 'renewal_offers', 'notices',
    -- M4
    'charges', 'payments', 'payment_allocations', 'bank_imports', 'bank_lines',
    'match_suggestions', 'late_fees', 'credit_notes', 'accounts', 'journal_entries',
    'journal_lines', 'period_locks',
    -- M6 (shared vendor master)
    'vendors',
    -- M5
    'tickets', 'work_orders', 'ticket_messages', 'attachments', 'classifications',
    'responsibilities', 'dispatches', 'vendor_quotes', 'completions', 'sla_clocks',
    'ticket_embeddings',
    -- M6
    'vendor_jobs', 'quotes', 'invoices', 'performance_scores',
    -- M7
    'owners', 'ownership_shares', 'owner_statements', 'distributions',
    'management_fees', 'owner_approvals', 'trust_accounts',
    -- M8
    'documents', 'inspections', 'insurance_policies', 'certifications',
    'notice_templates', 'legal_flags', 'service_standards',
    -- M9
    'saved_views', 'scheduled_reports',
    -- auth / audit
    'users', 'sessions', 'channel_identities', 'otp_codes', 'audit_events', 'agent_traces'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      'USING (organization_id = app.current_org_id()) '
      'WITH CHECK (organization_id = app.current_org_id())',
      t
    );
  END LOOP;
END;
$$;

-- Auth tables additionally allow a read-only, explicit auth-scope lookup
-- (login happens before an organization context exists).
DO $$
DECLARE
  t text;
  auth_tables text[] := ARRAY['users', 'sessions', 'channel_identities', 'otp_codes'];
BEGIN
  FOREACH t IN ARRAY auth_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS auth_scope_read ON %I', t);
    EXECUTE format(
      'CREATE POLICY auth_scope_read ON %I FOR SELECT USING (app.in_auth_scope())',
      t
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Append-only audit
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_events;
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.assert_audit_append_only();

-- ---------------------------------------------------------------------------
-- 3. Journal balance + posted-entry immutability
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_journal_balanced ON journal_entries;
CREATE TRIGGER trg_journal_balanced
  BEFORE INSERT OR UPDATE OF posted ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.assert_journal_balanced();

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_mutable();

-- ---------------------------------------------------------------------------
-- 4. Period locks
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_period_lock_charges ON charges;
CREATE TRIGGER trg_period_lock_charges
  BEFORE INSERT OR UPDATE ON charges
  FOR EACH ROW EXECUTE FUNCTION app.assert_period_open();

DROP TRIGGER IF EXISTS trg_period_lock_payments ON payments;
CREATE TRIGGER trg_period_lock_payments
  BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.assert_period_open();

DROP TRIGGER IF EXISTS trg_period_lock_journal_lines ON journal_lines;
CREATE TRIGGER trg_period_lock_journal_lines
  BEFORE INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.assert_period_open();

-- ---------------------------------------------------------------------------
-- 5. Sticky emergency flag
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_emergency_sticky ON tickets;
CREATE TRIGGER trg_emergency_sticky
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION app.assert_emergency_sticky();

-- ---------------------------------------------------------------------------
-- 6. updated_at maintenance for every table that has the column
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'updated_at'
       AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
      t
    );
  END LOOP;
END;
$$;
