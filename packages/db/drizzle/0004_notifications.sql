-- 0004_notifications: the proactive engine's three tables.
--
-- Why an outbox at all: "write the business fact" and "notify a human" cannot be
-- atomic. If the notification is sent before the commit, a rollback leaves a
-- human holding a message about a payment that never happened; if it is sent
-- after, a crash between the two loses it silently. So the scanner writes an
-- outbox row IN THE SAME TRANSACTION as the fact, and a relay publishes it
-- afterwards. A row in `outbox` is a promise that the fact is committed.
--
-- Why a dedupe key on the intent and not on the message: a daily 06:00 scan
-- runs ~365 times a year over the same lease. Without a *semantic* key
-- (`rent_due:charge:<id>:-3d`, not a random uuid) every run re-notifies the
-- same owner about the same charge. The unique index makes the second run a
-- no-op instead of a second WhatsApp message.

-- ---------------------------------------------------------------------------
-- 1. Outbox: append-only, written in the transaction that records the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  topic text NOT NULL,
  -- Semantic identity of the fact being announced. Unique per org so a re-run
  -- of a scanner cannot enqueue the same notification twice.
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_org_dedupe_idx
  ON outbox (organization_id, dedupe_key);
-- The relay's only query: find unpublished rows in commit order.
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox (published_at, created_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Notification intents: one row per human-facing interruption, and the
--    incident state machine (open → notified → acknowledged → closed).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_intents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  -- What fired: rent_due_soon | lease_expiring | ticket_sla_breach ...
  trigger_key text NOT NULL,
  dedupe_key text NOT NULL,
  tier smallint NOT NULL CHECK (tier BETWEEN 0 AND 3),
  channel text NOT NULL
    CHECK (channel IN ('whatsapp', 'telegram', 'email', 'in_app', 'log')),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  body_locale text NOT NULL DEFAULT 'en' CHECK (body_locale IN ('ar', 'en')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'notified', 'acked', 'resolved', 'declined', 'expired')),
  attempts integer NOT NULL DEFAULT 0,
  -- Anti-ping-pong: after this many, only a human can change the state.
  max_notifications integer NOT NULL DEFAULT 3 CHECK (max_notifications > 0),
  last_notified_at timestamptz,
  acked_at timestamptz,
  closed_at timestamptz,
  expires_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The dedupe guarantee. Same fact, same period => one intent, ever.
CREATE UNIQUE INDEX IF NOT EXISTS notification_intents_org_dedupe_idx
  ON notification_intents (organization_id, dedupe_key);
CREATE INDEX IF NOT EXISTS notification_intents_open_idx
  ON notification_intents (organization_id, tier, created_at DESC)
  WHERE status IN ('open', 'notified');
-- Escalation scans by age.
CREATE INDEX IF NOT EXISTS notification_intents_escalation_idx
  ON notification_intents (organization_id, last_notified_at)
  WHERE status = 'notified';

-- ---------------------------------------------------------------------------
-- 3. Sends: the delivery ledger. A suppression is recorded too — a notification
--    that was deliberately NOT sent is evidence the budget worked, and it is
--    the only way to measure interruption precision honestly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_sends (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  intent_id uuid NOT NULL REFERENCES notification_intents (id),
  channel text NOT NULL,
  provider_message_id text,
  -- Exactly one of these is meaningful: sent, or suppressed for a reason.
  suppressed_reason text
    CHECK (suppressed_reason IN ('quiet_hours', 'daily_budget', 'global_budget',
                                 'max_notifications', 'not_open', 'ambient_only',
                                 'cooldown', 'channel_disabled')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (provider_message_id IS NOT NULL AND suppressed_reason IS NULL)
    OR (provider_message_id IS NULL AND suppressed_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS notification_sends_budget_idx
  ON notification_sends (organization_id, sent_at)
  WHERE suppressed_reason IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Isolation + grants (same pattern as 0002/0003).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox', 'notification_intents', 'notification_sends']
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
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
      t
    );
  END LOOP;
END;
$$;

-- Sends are history: insert-only. Intents are updated (state machine), outbox
-- is updated once (published_at). Nothing here is ever deleted by the app role.
GRANT SELECT, INSERT, UPDATE ON outbox TO aqar_app;
GRANT SELECT, INSERT, UPDATE ON notification_intents TO aqar_app;
GRANT SELECT, INSERT ON notification_sends TO aqar_app;
