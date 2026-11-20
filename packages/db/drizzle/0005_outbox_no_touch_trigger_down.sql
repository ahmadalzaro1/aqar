-- Reverses 0005 (restores the defective state on purpose: down migrations are
-- not allowed to silently "fix" forward).
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON outbox
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
