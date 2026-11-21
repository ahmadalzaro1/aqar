-- A redeemed approval token, recorded once.
--
-- Until now "single use" was a property of action_proposals.status: the row said
-- executed, so a second decision was refused. That is a state, not a receipt —
-- it cannot show *when* the token was spent, by whom, or for which claims, and
-- it cannot survive anyone resetting the row to pending.
--
-- This table is the redemption itself: one row per proposal, ever. The primary
-- key does the enforcing (insert ... on conflict do nothing, then refuse if no
-- row came back), so two concurrent approvals of one proposal cannot both get
-- through, whatever the application does.
create table if not exists proposal_token_uses (
  proposal_id uuid primary key references action_proposals(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  token_hash text not null,
  claims jsonb not null,
  consumed_at timestamp with time zone not null,
  consumed_by_user_id uuid not null references users(id) on delete restrict
);

comment on table proposal_token_uses is
  'One row per redeemed approval token. The primary key is the single-use guarantee: a second redemption conflicts and is refused.';
comment on column proposal_token_uses.token_hash is
  'sha256 of the minted token. The token itself is never stored.';
