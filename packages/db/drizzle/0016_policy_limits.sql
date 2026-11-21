-- Policy is per organization, not per deployment.
--
-- The limits were a frozen constant in `@aqar/core`, so a second organization
-- with different ceilings required a second deployment, and changing a number
-- changed it retroactively for every historical decision.
--
-- A row here overrides the shipped default for one organization. No row means
-- the default, which keeps the version stable and avoids duplicating the numbers
-- in SQL where they would drift from the TypeScript. Either way the decision is
-- stamped with the version of whatever was actually used.
create table if not exists policy_limits (
  organization_id uuid primary key references organizations(id) on delete cascade,
  limits jsonb not null,
  updated_at timestamp with time zone not null default now(),
  updated_by_user_id uuid references users(id) on delete set null
);

comment on table policy_limits is
  'Per-org policy overrides. Absent row = DEFAULT_POLICY_LIMITS. The compiled version is stamped on every decision, so a change never rewrites history.';

comment on column policy_limits.limits is
  'Shape: PolicyLimits in @aqar/core. Validated strictly on read; an unreadable row refuses to decide rather than falling back to a wider policy.';
