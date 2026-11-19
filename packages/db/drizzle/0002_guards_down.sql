-- 0002_guards DOWN — removes every database guard created by 0002_guards.sql.
--
-- Runs first on a rollback (before tables are dropped). Policies are dropped
-- explicitly rather than relying on DROP TABLE, and RLS is disabled so the
-- tables can then be dropped cleanly.
--
-- The `aqar_app` ROLE is intentionally NOT dropped: roles are cluster-level and
-- dropping it would break sibling databases (aqar_test) that share the cluster.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'properties', 'buildings', 'units', 'amenities', 'unit_amenities', 'meters',
    'listings', 'inquiries', 'showings', 'applicants', 'applications',
    'screening_results', 'decisions',
    'tenants', 'leases', 'lease_tenants', 'lease_addendums', 'renewal_offers', 'notices',
    'charges', 'payments', 'payment_allocations', 'bank_imports', 'bank_lines',
    'match_suggestions', 'late_fees', 'credit_notes', 'accounts', 'journal_entries',
    'journal_lines', 'period_locks',
    'vendors',
    'tickets', 'work_orders', 'ticket_messages', 'attachments', 'classifications',
    'responsibilities', 'dispatches', 'vendor_quotes', 'completions', 'sla_clocks',
    'ticket_embeddings',
    'vendor_jobs', 'quotes', 'invoices', 'performance_scores',
    'owners', 'ownership_shares', 'owner_statements', 'distributions',
    'management_fees', 'owner_approvals', 'trust_accounts',
    'documents', 'inspections', 'insurance_policies', 'certifications',
    'notice_templates', 'legal_flags', 'service_standards',
    'saved_views', 'scheduled_reports',
    'users', 'sessions', 'channel_identities', 'otp_codes', 'audit_events', 'agent_traces'
  ];
  existing text;
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    SELECT to_regclass(format('public.%I', t))::text INTO existing;
    IF existing IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS auth_scope_read ON %I', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON %I', t);
    -- drop triggers that may not exist on every table: guarded by to_regclass above
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_append_only ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_journal_balanced ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_period_lock_charges ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_period_lock_payments ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_period_lock_journal_lines ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_emergency_sticky ON %I', t);
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS app.assert_audit_append_only() CASCADE;
DROP FUNCTION IF EXISTS app.assert_journal_balanced() CASCADE;
DROP FUNCTION IF EXISTS app.assert_entry_mutable() CASCADE;
DROP FUNCTION IF EXISTS app.assert_period_open() CASCADE;
DROP FUNCTION IF EXISTS app.assert_emergency_sticky() CASCADE;
DROP FUNCTION IF EXISTS app.touch_updated_at() CASCADE;
DROP FUNCTION IF EXISTS app.current_org_id() CASCADE;
DROP FUNCTION IF EXISTS app.in_auth_scope() CASCADE;

DROP SCHEMA IF EXISTS app CASCADE;
