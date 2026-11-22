-- 0019 down — reverses the trade vocabulary.
--
-- DATA LOSS, stated plainly: this migration destroys information.
--
--   1. `vendors.licence_expires_on` is dropped with any dates recorded in it.
--      Those dates cannot be recovered from anywhere else: `licence` is free
--      text and nothing else in the schema carries a licence clock.
--   2. `equipment_trade_map` and `trade_job_templates` are dropped, taking the
--      asset→trade join and 28 job templates with them.
--   3. Nine trades cannot be expressed in the retired 13-word vocabulary
--      (`roofer_waterproofing`, `security_systems`, `kitchen_carpentry`,
--      `gate_automation`, `signage_install`, `solar_pv`, plus `drainage`,
--      `water_tank` and `handyman`, which the old type also lacked). A vendor
--      typed with one of them is rewritten to the closest legacy word below —
--      that is a guess, and the guess is what the old type forced.
--
-- Take a `pg_dump` of `vendors`, `equipment_trade_map` and `trade_job_templates`
-- before running this on anything that matters.

alter table vendors drop constraint vendors_trades_canonical_ck;
drop function vendor_trades_are_canonical(jsonb);

-- Reverse the normalisation, and fold the tokens the old vocabulary never had
-- into the legacy buckets. Order matters: the array is rebuilt from the mapping.
with mapping(new_word, old_word) as (
  values
    ('plumber', 'plumbing'),
    ('electrician', 'electrical'),
    ('gas_safety', 'gas'),
    ('appliance_repair', 'appliance'),
    ('pest_control', 'pest'),
    ('structural_engineer', 'structural'),
    ('kitchen_carpentry', 'carpentry'),
    ('handyman', 'painting'),
    -- no legacy equivalent; folded into the nearest bucket, as described above:
    ('roofer_waterproofing', 'structural'),
    ('security_systems', 'electrical'),
    ('gate_automation', 'electrical'),
    ('signage_install', 'painting'),
    ('solar_pv', 'electrical'),
    ('drainage', 'plumbing'),
    ('water_tank', 'plumbing')
),
rewritten as (
  select
    v.id,
    coalesce(
      (
        select jsonb_agg(distinct coalesce(m.old_word, e.word))
        from jsonb_array_elements_text(v.trades) as e(word)
        left join mapping m on m.new_word = e.word
        -- hvac, elevator, cleaning, generator, locksmith are unchanged.
        where coalesce(m.old_word, e.word) in (
          'plumbing', 'electrical', 'hvac', 'gas', 'elevator', 'cleaning',
          'carpentry', 'pest', 'appliance', 'generator', 'painting',
          'locksmith', 'structural'
        )
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

alter table vendors drop column licence_expires_on;

drop table trade_job_templates;
drop table equipment_trade_map;
drop type vendor_trade;
