-- 0023 — expenses: costs the organisation pays directly.
--
-- Why this is not `invoices`: invoices.vendor_id is NOT NULL, so it can only
-- hold a supplier's bill. Electricity, water, municipal fees, insurance, tax
-- and salaries have no supplier to name — they had nowhere to go, which is why
-- "how much did we spend on X" had no table to read even though `invoices`
-- existed. This table holds that half of the ledger; `completions.cost_fils`
-- holds the maintenance half, and `invoices` holds the supplier half.
--
-- Nothing is seeded. Zero rows is the honest state and the tools report it as
-- a zero, not as a refusal.

begin;

do $$ begin
  create type expense_category as enum (
    'utilities_electricity', 'utilities_water', 'utilities_gas',
    'municipal_fees', 'insurance', 'property_tax', 'salaries',
    'cleaning', 'security', 'management', 'legal', 'marketing', 'other'
  );
exception when duplicate_object then null; end $$;

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  -- null = a cost that belongs to the organisation, not to one building.
  property_id uuid references properties (id) on delete set null,
  unit_id uuid references units (id) on delete set null,
  category expense_category not null,
  description text not null,
  amount_fils integer not null check (amount_fils >= 0),
  vat_fils integer not null default 0 check (vat_fils >= 0),
  -- The service window this cost covers (a utility bill covers a month).
  period_start date,
  period_end date,
  -- When the cost was incurred, which is what a "this year" question filters on.
  incurred_on date not null,
  paid_at timestamptz,
  -- Optional: some direct costs do have a supplier, and then they may also be
  -- reconciled against that supplier's invoice.
  vendor_id uuid references vendors (id) on delete set null,
  invoice_number text,
  document_id uuid references documents (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_period_order
    check (period_end is null or period_start is null or period_end >= period_start)
);

create index if not exists expenses_org_incurred_idx
  on expenses (organization_id, incurred_on desc);

create index if not exists expenses_property_idx
  on expenses (organization_id, property_id, category);

comment on table expenses is
  'Costs the organisation pays directly (utilities, municipal fees, insurance, tax, salaries). Supplier bills belong in invoices; completed repair costs live in completions.cost_fils.';

commit;
