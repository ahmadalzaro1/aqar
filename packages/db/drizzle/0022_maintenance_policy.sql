-- 0022 — maintenance_policy: who bears a repair, by equipment kind.
--
-- This table is the difference between "the console refuses" and "the console
-- answers the water-heater question". It is deliberately empty on creation:
-- a responsibility split is a business decision, not a fact a migration may
-- invent. What the migration supplies is the *shape* of the answer and the
-- integrity rules that keep an unsourced claim out of it.
--
-- Resolution order the resolver must follow (property row beats org row):
--   lease clause → property policy → organisation policy → statutory → refuse

begin;

do $$ begin
  create type maintenance_responsibility as enum ('landlord', 'tenant', 'shared', 'warranty');
exception when duplicate_object then null; end $$;

do $$ begin
  create type wear_basis as enum ('wear', 'damage', 'either');
exception when duplicate_object then null; end $$;

create table if not exists maintenance_policy (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  -- null = the rule applies to the whole organisation.
  property_id uuid references properties (id) on delete cascade,
  equipment_kind equipment_kind not null,
  responsibility maintenance_responsibility not null,
  -- Wear is the landlord's, damage the tenant's, in most leases; 'either'
  -- means the row does not split them and the caller must not pretend it does.
  wear_vs_damage wear_basis not null default 'either',
  basis text not null,
  legal_reference_id uuid references legal_reference (id) on delete restrict,
  lease_clause_key text references lease_clause_types (key) on delete restrict,
  note_ar text,
  note_en text,
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint maintenance_policy_basis_valid
    check (basis in ('lease_clause', 'org_policy', 'statutory')),
  -- A statutory row without a reviewed article is an assertion, not a citation.
  constraint maintenance_policy_basis_source check (
    (basis = 'statutory' and legal_reference_id is not null)
    or (basis = 'lease_clause' and lease_clause_key is not null)
    or basis = 'org_policy'
  ),
  constraint maintenance_policy_window
    check (effective_to is null or effective_to > effective_from)
);

-- One live rule per scope: an org-wide row and a property row may coexist,
-- two live org-wide rows for the same kind may not.
create unique index if not exists maintenance_policy_active_uniq
  on maintenance_policy (
    organization_id,
    coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid),
    equipment_kind
  )
  where effective_to is null;

create index if not exists maintenance_policy_lookup_idx
  on maintenance_policy (organization_id, equipment_kind, property_id);

comment on table maintenance_policy is
  'Who bears a repair, by equipment_kind, effective-dated. Property rows override org rows. A statutory basis must cite a reviewed legal_reference; an org_policy basis is the organisation''s own decision and is reported as such, never as law.';

commit;
