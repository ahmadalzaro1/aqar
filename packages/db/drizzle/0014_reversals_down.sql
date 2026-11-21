drop table if exists proposal_reversals;
drop index if exists payments_live_by_org;
alter table payments
  drop column if exists voided_by_user_id,
  drop column if exists void_reason,
  drop column if exists voided_at;
alter table action_proposals drop constraint if exists action_proposals_status_check;
alter table action_proposals add constraint action_proposals_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed'));
