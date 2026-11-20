-- 0005: outbox must not carry the updated_at touch trigger.
--
-- 0004 applied trg_touch_updated_at to all three tables in one loop. Two of
-- them have an updated_at column; outbox deliberately does not (it is
-- append-only, plus a single published mark). The trigger function writes
-- NEW.updated_at, so every publish died with
--   PostgresError: record "new" has no field "updated_at"
-- and the relay transaction rolled back, silently losing the whole cycle.
--
-- Fixed here rather than by editing 0004: an applied migration is the record of
-- what ran. This is the correction, and it is idempotent.

DROP TRIGGER IF EXISTS trg_touch_updated_at ON outbox;
