-- 0019 — the trade vocabulary, and the join that was missing.
--
-- The problem this closes: `vendors.trades` was untyped jsonb of free strings
-- written in a private 13-word vocabulary (plumbing, electrical, carpentry,
-- painting, gas, pest, appliance, structural). The dispatch matcher works in
-- `Trade` tokens (plumber, electrician, hvac, gas_safety, …). The two
-- vocabularies overlapped in five words, so a vendor typed `plumbing` could not
-- be matched by a `plumber` job. The console hid this by deriving aliases from
-- the taxonomy before matching; the agent path did not derive them and matched
-- with `ilike`, so the same question returned a different roster depending on
-- who asked. Nothing joined an asset's `equipment_kind` (32 values, 0018) to a
-- trade at all, which meant the twin could report a failed pump and dispatch
-- could name the plumber, and no code could connect the two.
--
-- Three changes, in order of blast radius:
--
--   1. A canonical `vendor_trade` enum, with a CHECK on `vendors.trades` that
--      refuses any element outside it. The vocabulary is now enforced where the
--      data lives, not only in a TypeScript union.
--   2. `equipment_trade_map` — the join. Reference data, identical for every
--      organisation, so no organization_id and no RLS.
--   3. `trade_job_templates` — what a trade does on a cadence, with the four
--      statutory obligations in Amman called out separately from the
--      manufacturer's recommendations. `service_standards` holds SLA clocks
--      only; nothing held preventive cadence, so an elevator inspection was a
--      note in someone's head.
--
-- Existing rows are normalised in place below. The mapping is lossless for the
-- eight legacy tokens; `carpentry` becomes `kitchen_carpentry` and `painting`
-- becomes `handyman`, which is the closest thing the old vocabulary had.

create type vendor_trade as enum (
  'gas_safety',
  'fire_safety',
  'electrician',
  'plumber',
  'drainage',
  'water_tank',
  'hvac',
  'structural_engineer',
  'locksmith',
  'elevator',
  'appliance_repair',
  'pest_control',
  'cleaning',
  'generator',
  'handyman',
  -- capabilities that exist as assets before they exist as ticket categories:
  'roofer_waterproofing',
  'security_systems',
  'kitchen_carpentry',
  'gate_automation',
  'signage_install',
  'solar_pv'
);

-- Normalise the roster that was typed in the retired vocabulary. Array order and
-- duplicates are preserved-through-dedup: a vendor listing both `plumbing` and
-- `plumber` ends up with one `plumber`, not two.
with mapping(old_word, new_word) as (
  values
    ('plumbing', 'plumber'),
    ('electrical', 'electrician'),
    ('gas', 'gas_safety'),
    ('appliance', 'appliance_repair'),
    ('pest', 'pest_control'),
    ('structural', 'structural_engineer'),
    ('carpentry', 'kitchen_carpentry'),
    ('painting', 'handyman')
),
rewritten as (
  select
    v.id,
    coalesce(
      (
        select jsonb_agg(distinct coalesce(m.new_word, e.word))
        from jsonb_array_elements_text(v.trades) as e(word)
        left join mapping m on m.old_word = e.word
      ),
      '[]'::jsonb
    ) as trades
  from vendors v
)
update vendors v
set trades = r.trades
from rewritten r
where r.id = v.id
  and v.trades is distinct from r.trades;

-- The licence clock. `licence` was free text with no expiry, which is a
-- decoration: a statutory trade (elevator, gas, fire, signage) cannot be
-- dispatched on a certificate nobody can date.
alter table vendors add column licence_expires_on date;

-- Refuse to hold a trade that is not in the vocabulary. A function rather than a
-- CHECK expression because a CHECK may not contain a subquery; the function is
-- immutable, so it is legal in a constraint.
create function vendor_trades_are_canonical(value jsonb) returns boolean
  language sql
  immutable
  parallel safe
as $$
  select not exists (
    select 1
    from jsonb_array_elements_text(value) as e(word)
    where e.word not in (select unnest(enum_range(null::vendor_trade)::text[]))
  );
$$;

comment on function vendor_trades_are_canonical(jsonb) is
  'True when every element of a vendors.trades array is a vendor_trade token.';

alter table vendors
  add constraint vendors_trades_canonical_ck
  check (vendor_trades_are_canonical(trades));

-- The join: which trade looks after which kind of asset.
create table equipment_trade_map (
  equipment_kind equipment_kind not null,
  trade vendor_trade not null,
  priority smallint not null default 0,
  constraint equipment_trade_map_pkey primary key (equipment_kind, trade),
  constraint equipment_trade_map_priority_ck check (priority >= 0)
);

create index equipment_trade_map_trade_idx on equipment_trade_map (trade);

comment on table equipment_trade_map is
  'Reference data: trade[s] that service an equipment_kind, primary (priority 0) first. Global, not per-tenant.';

-- What a trade does on a cadence, and which of those obligations are statutory.
create table trade_job_templates (
  code text primary key,
  trade vendor_trade not null,
  title_en text not null,
  title_ar text not null,
  cadence_days integer,
  cadence_basis text,
  statutory boolean not null default false,
  statutory_authority text,
  requires_certificate boolean not null default false,
  equipment_kinds equipment_kind[] not null default '{}'::equipment_kind[],
  notes text,
  constraint trade_job_templates_cadence_ck check (cadence_days is null or cadence_days > 0),
  constraint trade_job_templates_basis_ck
    check ((cadence_days is null) = (cadence_basis is null)),
  constraint trade_job_templates_basis_value_ck
    check (cadence_basis is null or cadence_basis in ('statutory', 'manufacturer', 'recommended')),
  -- A statute without an authority is a rumour.
  constraint trade_job_templates_statutory_ck
    check (not statutory or (statutory_authority is not null and cadence_basis = 'statutory'))
);

create index trade_job_templates_trade_idx on trade_job_templates (trade);

comment on table trade_job_templates is
  'Reference data: preventive cadence per trade. cadence_days null = reactive. cadence_basis separates a statutory interval from a manufacturer recommendation from our own judgement.';

grant select on equipment_trade_map, trade_job_templates to aqar_app;

insert into equipment_trade_map (equipment_kind, trade, priority) values
  ('structure', 'structural_engineer', 0),
  ('roof', 'roofer_waterproofing', 0),
  ('envelope', 'roofer_waterproofing', 0),
  ('envelope', 'handyman', 1),
  ('water_supply', 'plumber', 0),
  ('water_tank', 'water_tank', 0),
  ('pump', 'plumber', 0),
  ('drainage', 'drainage', 0),
  ('sewer', 'drainage', 0),
  ('gas_network', 'gas_safety', 0),
  ('gas_cylinder', 'gas_safety', 0),
  ('electrical_panel', 'electrician', 0),
  ('wiring', 'electrician', 0),
  ('generator', 'generator', 0),
  ('solar', 'solar_pv', 0),
  ('hvac_split', 'hvac', 0),
  ('hvac_central', 'hvac', 0),
  ('water_heater', 'plumber', 0),
  ('water_heater', 'electrician', 1),
  ('elevator', 'elevator', 0),
  ('fire_alarm', 'fire_safety', 0),
  ('fire_extinguisher', 'fire_safety', 0),
  ('fire_riser', 'fire_safety', 0),
  ('security_access', 'security_systems', 0),
  ('cctv', 'security_systems', 0),
  ('intercom', 'security_systems', 0),
  ('intercom', 'electrician', 1),
  ('door_lock', 'locksmith', 0),
  ('kitchen', 'kitchen_carpentry', 0),
  ('appliance', 'appliance_repair', 0),
  ('plumbing_fixture', 'plumber', 0),
  ('lighting', 'electrician', 0),
  ('lighting', 'handyman', 1),
  ('parking_equipment', 'gate_automation', 0),
  ('signage', 'signage_install', 0),
  ('other', 'handyman', 0);


insert into trade_job_templates (code, trade, title_en, title_ar, cadence_days,
  cadence_basis, statutory, statutory_authority, requires_certificate,
  equipment_kinds, notes) values
  ('elevator_periodic_maintenance', 'elevator', 'Elevator preventive maintenance', 'صيانة وقائية للمصعد', 30, 'recommended', false, null, true, array['elevator']::"equipment_kind"[], 'Maintenance contract; the licence depends on the statutory inspection.'),
  ('elevator_statutory_inspection', 'elevator', 'Elevator statutory inspection and licence renewal', 'كشف وتجديد رخصة المصعد', 365, 'statutory', true, 'GAM', true, array['elevator']::"equipment_kind"[], 'Confirm the current interval with GAM before relying on 365 days.'),
  ('water_tank_clean', 'water_tank', 'Water tank clean and disinfect', 'تنظيف وتعقيم خزان المياه', 90, 'recommended', false, null, false, array['water_tank']::"equipment_kind"[], 'Quarterly is the health-driven default; a rooftop tank in summer is worse.'),
  ('gas_leak_response', 'gas_safety', 'Gas leak callout', 'كشف تسرب غاز', null, null, false, null, true, array['gas_network', 'gas_cylinder']::"equipment_kind"[], 'Reactive. The technician must be certified: an uncertified repair voids cover.'),
  ('gas_installation_certificate', 'gas_safety', 'Gas installation certificate', 'شهادة سلامة تمديدات الغاز', 365, 'statutory', true, 'GAM', true, array['gas_network']::"equipment_kind"[], 'Confirm interval and issuing body before relying on 365 days.'),
  ('fire_extinguisher_service', 'fire_safety', 'Fire extinguisher service', 'صيانة طفايات الحريق', 365, 'statutory', true, 'CDD', true, array['fire_extinguisher']::"equipment_kind"[], 'Annual service tag; the certificate is what an inspection asks for.'),
  ('fire_alarm_test', 'fire_safety', 'Fire alarm system test', 'فحص نظام إنذار الحريق', 180, 'recommended', false, null, true, array['fire_alarm']::"equipment_kind"[], 'Six-monthly test is the practice; confirm against the building classification.'),
  ('fire_riser_pressure_test', 'fire_safety', 'Fire riser pressure test', 'فحص ضغط شبكة الإطفاء', 365, 'recommended', false, null, true, array['fire_riser']::"equipment_kind"[], null),
  ('plumbing_leak_repair', 'plumber', 'Plumbing leak repair', 'إصلاح تسرب', null, null, false, null, false, array['water_supply', 'pump', 'plumbing_fixture']::"equipment_kind"[], 'Highest call volume in an old Weibdeh building.'),
  ('pump_service', 'plumber', 'Booster pump service', 'صيانة مضخة المياه', 365, 'manufacturer', false, null, false, array['pump']::"equipment_kind"[], 'Roof tank plus booster pump is the standard Weibdeh arrangement.'),
  ('drainage_jetting', 'drainage', 'Drain and sewer jetting', 'تسليك المجاري بالضغط', 365, 'recommended', false, null, false, array['drainage', 'sewer']::"equipment_kind"[], 'Older clay runs benefit from an annual pass before the winter.'),
  ('electrical_panel_inspection', 'electrician', 'Electrical panel thermographic inspection', 'فحص لوحة الكهرباء', 365, 'recommended', false, null, true, array['electrical_panel', 'wiring']::"equipment_kind"[], 'Aluminium wiring in 1970s stock is the reason this exists.'),
  ('hvac_split_service', 'hvac', 'Split unit service', 'صيانة مكيف سبليت', 180, 'manufacturer', false, null, false, array['hvac_split']::"equipment_kind"[], 'Twice a year: before summer, after summer.'),
  ('hvac_central_service', 'hvac', 'Central chiller/boiler service', 'صيانة التكييف المركزي', 90, 'manufacturer', false, null, false, array['hvac_central']::"equipment_kind"[], 'A chiller technician is not a split-unit technician; rate cards differ by multiples.'),
  ('generator_service', 'generator', 'Generator service and load test', 'صيانة المولد وفحص الحمل', 90, 'manufacturer', false, null, true, array['generator']::"equipment_kind"[], null),
  ('water_heater_service', 'plumber', 'Water heater service', 'صيانة سخان المياه', 365, 'recommended', false, null, false, array['water_heater']::"equipment_kind"[], 'Anode/scale check; the electric variant lands with the electrician instead.'),
  ('locksmith_callout', 'locksmith', 'Lock and key callout', 'فتح أقفال', null, null, false, null, false, array['door_lock']::"equipment_kind"[], null),
  ('appliance_repair', 'appliance_repair', 'Appliance repair', 'إصلاح أجهزة', null, null, false, null, false, array['appliance']::"equipment_kind"[], 'Usually the tenant who calls, the landlord who pays only if the appliance is his.'),
  ('pest_control', 'pest_control', 'Pest control treatment', 'مكافحة حشرات', 365, 'recommended', false, null, false, array['other']::"equipment_kind"[], 'Common areas and refuse shafts; the treatment certificate matters for tenants.'),
  ('common_area_cleaning', 'cleaning', 'Common area cleaning', 'تنظيف المناطق المشتركة', 7, 'recommended', false, null, false, array['other']::"equipment_kind"[], 'The stairwell and the roof are the two surfaces tenants judge the building by.'),
  ('roof_waterproofing_survey', 'roofer_waterproofing', 'Roof waterproofing survey', 'فحص عزل السطح', 730, 'recommended', false, null, false, array['roof', 'envelope', 'structure']::"equipment_kind"[], 'Biennial survey, always before the first winter rain rather than after.'),
  ('solar_pv_service', 'solar_pv', 'Solar PV service', 'صيانة الألواح الشمسية', 365, 'manufacturer', false, null, true, array['solar']::"equipment_kind"[], 'Panel clean plus inverter check; the utility agreement is a separate clock.'),
  ('security_systems_check', 'security_systems', 'CCTV, intercom and access control check', 'فحص الكاميرات والانتركم', 180, 'recommended', false, null, false, array['cctv', 'intercom', 'security_access']::"equipment_kind"[], 'Retention/legal basis for footage belongs with the privacy policy, not here.'),
  ('gate_automation_service', 'gate_automation', 'Parking barrier service', 'صيانة حاجز المواقف', 180, 'manufacturer', false, null, false, array['parking_equipment']::"equipment_kind"[], null),
  ('signage_permit_renewal', 'signage_install', 'Commercial signage permit renewal', 'تجديد ترخيص اللافتات', 365, 'statutory', true, 'GAM', false, array['signage']::"equipment_kind"[], 'Only for commercial units; confirm the fee schedule with GAM.'),
  ('structural_survey', 'structural_engineer', 'Structural survey', 'فحص إنشائي', 1825, 'recommended', false, null, true, array['structure', 'envelope']::"equipment_kind"[], 'Five-yearly for pre-1980 stock; a crack is not the time to look for the file.'),
  ('kitchen_carpentry_callout', 'kitchen_carpentry', 'Kitchen and joinery callout', 'صيانة مطابخ ونجارة', null, null, false, null, false, array['kitchen']::"equipment_kind"[], null),
  ('handyman_callout', 'handyman', 'General handyman callout', 'صيانة عامة', null, null, false, null, false, array['other', 'lighting']::"equipment_kind"[], 'The catch-all: if a job cannot name its trade, it lands here.');
