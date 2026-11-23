-- 0021 — what the lease actually says, as structured obligation.
--
-- `lease_addendums.body_md` is free text. A question like "does my lease make me
-- pay for the water heater?" can only be answered from free text by an LLM
-- guessing, and a guess is exactly what an operator cannot put in front of a
-- tenant. This migration gives the lease a small, typed vocabulary of clauses
-- that carry obligation semantics — who pays, who decides, when, how much —
-- plus the provenance needed to say whether a clause was typed by a human or
-- parsed from a PDF.
--
-- Honesty rule encoded in the columns: `extracted_by = 'parser:…'` with a
-- `confidence` below the review threshold is reported to the operator as
-- "parsed, unconfirmed", never as the answer. The tool sets `confirmed` from
-- these two fields; it does not decide by itself what is trustworthy.
--
-- `leases.auto_renew` lands here because auto-renewal is real Jordanian law for
-- leases concluded from 31 Aug 2000 onward — it belongs in the model, where it
-- can be cited, not in a prompt.

create table lease_clause_types (
  key             text primary key,
  label_ar        text not null,
  label_en        text not null,
  obligation_axis text not null check (obligation_axis in ('who_pays', 'who_decides', 'timing', 'amount')),
  default_value   jsonb
);

insert into lease_clause_types (key, label_ar, label_en, obligation_axis, default_value) values
  ('repairs_structural', 'إصلاحات إنشائية',       'Structural repairs',      'who_pays',    '{"responsibility":"landlord"}'),
  ('repairs_appliance',  'إصلاح الأجهزة',          'Appliance repairs',       'who_pays',    '{"responsibility":"landlord"}'),
  ('service_charge',     'رسوم الخدمات',           'Service charges',         'who_pays',    '{"responsibility":"tenant"}'),
  ('sublet',             'التأجير من الباطن',      'Subletting',              'who_decides', '{"allowed":false}'),
  ('pets',               'الحيوانات الأليفة',      'Pets',                    'who_decides', '{"allowed":false}'),
  ('notice_period',      'مدة الإخطار',            'Notice period',           'timing',      null),
  ('escalation',         'الزيادة السنوية',        'Annual escalation',       'amount',      null),
  ('deposit_refund',     'استرداد التأمين',        'Deposit refund',          'who_pays',    null),
  ('early_termination',  'الإنهاء المبكر',         'Early termination',       'who_decides', null),
  ('auto_renewal',       'التجديد التلقائي',       'Auto renewal',            'timing',      null),
  ('entry_rights',       'حق الدخول',              'Entry rights',            'who_decides', '{"hours_notice":48}');

create table lease_clauses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  lease_id        uuid not null references leases(id),
  clause_key      text not null references lease_clause_types(key),
  value           jsonb not null,
  text_ar         text,
  text_en         text,
  document_id     uuid references documents(id),
  page_ref        text,
  extracted_by    text,                  -- 'human' | 'parser:<name>@<version>'
  confidence      numeric,
  effective_from  date,
  unique (lease_id, clause_key, effective_from)
);

create index lease_clauses_lease_idx on lease_clauses (lease_id);
create index lease_clauses_org_key_idx on lease_clauses (organization_id, clause_key);

alter table leases add column if not exists auto_renew boolean not null default false;

-- A clause is confirmed only when a human typed it, or a parser produced it and
-- a reviewer accepted it. Everything else is surfaced as unconfirmed.
alter table lease_clauses add constraint lease_clauses_confidence_check
  check (confidence is null or (confidence >= 0 and confidence <= 1));

create view lease_clauses_confirmed as
  select * from lease_clauses
  where extracted_by = 'human'
     or (extracted_by like 'parser:%' and confidence is not null and confidence >= 0.95);
