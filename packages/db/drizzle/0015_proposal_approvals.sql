-- Dual control: the second key needs somewhere to live.
--
-- `action_proposals` carried exactly one approver (`decided_by_user_id`), so
-- "two people must sign" was not expressible — the second signature had nowhere
-- to be recorded, and therefore could not be required or proved.
--
-- The primary key is the control, not the handler: (proposal_id, approver_id)
-- means a retry, a double click or a status reset cannot manufacture a second
-- signature from the same person. Distinctness is a database fact.
create table if not exists proposal_approvals (
  proposal_id uuid not null references action_proposals(id) on delete cascade,
  approver_id uuid not null references users(id) on delete restrict,
  role        text not null,
  approved_at timestamp with time zone not null default now(),
  primary key (proposal_id, approver_id)
);

comment on table proposal_approvals is
  'One row per distinct approver per proposal. The primary key is the dual-control invariant.';

create index if not exists proposal_approvals_by_approver
  on proposal_approvals (approver_id, approved_at desc);

-- Backfill: a proposal that already executed had exactly one approver on record.
-- Recording it keeps "how many signatures did this take" answerable for history
-- instead of pretending those rows were never signed.
insert into proposal_approvals (proposal_id, approver_id, role, approved_at)
select p.id, p.decided_by_user_id, u.role, coalesce(p.decided_at, p.executed_at, p.created_at)
  from action_proposals p
  join users u on u.id = p.decided_by_user_id
 where p.decided_by_user_id is not null
on conflict (proposal_id, approver_id) do nothing;
