-- Reversal: the other half of "every action is reversible".
--
-- Two things were missing. `payments` had no way to say "this receipt was voided"
-- without deleting a row, and `action_proposals.status` had no `reversed`. Both
-- now exist, and `proposal_reversals` makes the reversal itself a receipt: its
-- primary key is the proposal, so a proposal can be reversed exactly once.
alter table action_proposals drop constraint if exists action_proposals_status_check;
alter table action_proposals add constraint action_proposals_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed', 'reversed'));

alter table payments
  add column if not exists voided_at timestamp with time zone,
  add column if not exists void_reason text,
  add column if not exists voided_by_user_id uuid references users(id) on delete restrict;

comment on column payments.voided_at is
  'A voided receipt stays in the ledger and stops counting: nothing is hard-deleted, corrections are reversals.';

create index if not exists payments_live_by_org
  on payments (organization_id, received_date)
  where voided_at is null;

create table if not exists proposal_reversals (
  proposal_id uuid primary key references action_proposals(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  reversed_by_user_id uuid not null references users(id) on delete restrict,
  reason text not null check (length(btrim(reason)) >= 10),
  reversed_at timestamp with time zone not null,
  effect jsonb not null,
  audit_event_id uuid
);

comment on table proposal_reversals is
  'One row per reversed proposal. The primary key makes reversal single-use, the same way proposal_token_uses makes approval single-use.';
