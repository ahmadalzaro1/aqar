-- 0020 — the legal corpus, as citable records and never as model memory.
--
-- Every Tier-3 question ("who pays for the water heater?", "can I evict for
-- non-payment?", "can I raise the rent at renewal?") has an answer in Jordanian
-- law and no answer in this database. Until now the assistant answered those
-- from model memory, which is the one failure mode a landlord cannot audit.
--
-- The rule this migration encodes: an answer about the law must name an
-- instrument and an article, and that row must carry a source URL and a human
-- reviewer. Rows may be staged (retrieved but unreviewed) — they simply do not
-- become citable until reviewed. `legal_reference_citable` is the only view the
-- answering tools are allowed to read, so "unreviewed" cannot leak into an
-- answer by forgetting a WHERE clause.
--
-- Reference data, identical for every organisation: no organization_id, no
-- tenancy filter.

create table legal_reference (
  id             uuid primary key default gen_random_uuid(),
  jurisdiction   text not null default 'JO',
  instrument     text not null,          -- 'Landlords and Tenants Law No. 11/1994'
  article        text,                   -- '4', '5/a' — null only for a whole instrument
  applies_to     text not null,          -- eviction | rent_increase | deposit | repairs | auto_renewal
  summary_ar     text not null,
  summary_en     text not null,
  verbatim_ar    text,
  effective_from date,
  effective_to   date,
  source_url     text,
  retrieved_at   timestamptz,
  reviewed_by    text,
  reviewed_at    timestamptz,
  constraint legal_reference_identity unique (jurisdiction, instrument, article, applies_to)
);

create index legal_reference_applies_to_idx on legal_reference (applies_to);

-- The only shape an answering tool may read. An answer that cannot cite a
-- reviewed article is a refusal, not an opinion.
create view legal_reference_citable as
  select id, jurisdiction, instrument, article, applies_to,
         summary_ar, summary_en, effective_from, effective_to,
         source_url, reviewed_by, reviewed_at
  from legal_reference
  where source_url is not null
    and reviewed_by is not null
    and (effective_to is null or effective_to >= current_date);
