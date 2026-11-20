# Aqar — domain ontology

> Verified against the live database on 2026-11-21: 84 tables, **184 foreign keys**,
> **129 CHECK constraints**, migrations `0001`–`0009`. Where this document and the
> schema disagree, the schema wins and this document is the defect.

Aqar models a property business as **five kinds of thing** and the edges between
them. Each kind exists because it has a different lifecycle: money is reversed,
space is re-let, work is closed, a lease expires, a governance record is never
touched again.

## 1. The five kinds

| Kind | Lifecycle | Tables |
|---|---|---|
| **Money & obligation** | append-only; corrected by reversal | `charges` `late_fees` `payments` `payment_allocations` `invoices` `credit_notes` `journal_entries`/`_lines` `distributions` `management_fees` `owner_statements` `trust_accounts` `period_locks` |
| **Rights over time** | interval with terms | `properties` `buildings` `units` `leases` `lease_tenants` `lease_addendums` `renewal_offers` `notices` `notice_templates` |
| **Work & duty** | open → closed | `tickets` `ticket_messages` `work_orders` `vendor_jobs` `vendor_quotes` `quotes` `dispatches` `sla_clocks` `service_standards` `responsibilities` `inspections` `certifications` `meters` `documents` `attachments` |
| **Owner money-in-trust** | gated by approval | `owners` `ownership_shares` `owner_approvals` `distributions` `owner_statements` |
| **Agent & governance** | immutable | `action_proposals` `agent_traces` `decisions` `audit_events` `outbox` `notification_intents`/`_sends`/`_acks` `classifications` `legal_flags` `channels` `channel_identities` `whatsapp_templates` |

## 2. Asset vs space — the correction in 0008

v1 had one shape for every lettable thing, and it was a flat: `units` required a
`building_id` and required `bedrooms`/`bathrooms`. **A plot of land could not exist
in the system at all.** The fix separates two levels that were being conflated:

```
properties  = the ASSET      a registered thing: deed, zoning, land area
  └─ buildings = the STRUCTURE inside it (floors, year built, elevator)
       └─ units = the SPACE   what a lease points at
```

`units` is now the **lettable space** table. Three kinds have no building (they
stand on ground or a roof), and the database enforces that:

```sql
CASE space_kind
  WHEN 'land' THEN building_id IS NULL
  WHEN 'farm' THEN building_id IS NULL
  WHEN 'rooftop' THEN building_id IS NULL
  WHEN 'signage' THEN building_id IS NULL
  WHEN 'parking' THEN TRUE          -- a lot has none; a basement bay does
  ELSE building_id IS NOT NULL
END
```

### 2.1 `asset_kind` — what we administer

| Value | Meaning | Can contain spaces |
|---|---|---|
| `parcel` | bare registered land | land, parking, signage (farm if zoned agricultural) |
| `building` | a building at one address | flats, offices, shops, workshops, parking, rooftop |
| `compound` | several structures, one wall | villas, flats, staff housing, labour camp, parking |
| `tower` | multi-storey, multi-use | as a building, plus showrooms |
| `farm` | agricultural holding | farm, land, warehouse, staff housing |
| `mixed_use` | retail + office + residential | flat, office, shop, showroom, parking, rooftop |
| `infrastructure` | signage, rooftop plant | signage, rooftop |

`properties.zoning` (nullable, CHECK-constrained): `residential`, `commercial`,
`industrial`, `agricultural`, `mixed`, `touristic`, `educational`, `health`,
`religious`, `public`, `military`. Zoning is **what the municipality says may
happen there**, not a promise about the lease.

### 2.2 `space_kind` — what can be leased

| Value | Detail family | Attribute that defines it | Publish requires |
|---|---|---|---|
| `flat` | residential | bedrooms / bathrooms | `area_sqm` |
| `villa` | residential | bedrooms / parking | `area_sqm`, `has_parking` |
| `staff_housing` | residential | occupancy | `area_sqm` |
| `labour_camp` | residential | occupancy, shared facilities | `area_sqm` |
| `office` | commercial | fit-out level | `area_sqm`, `fit_out` |
| `shop` | commercial | **frontage**, display windows | `area_sqm`, `frontage_m` |
| `showroom` | commercial | frontage, ceiling | `area_sqm`, `frontage_m` |
| `workshop` | commercial | roller shutter, power | `area_sqm` |
| `warehouse` | industrial | **clear height**, dock doors | `area_sqm`, `clear_height_m`, `dock_doors` |
| `cold_store` | industrial | temperature range | `area_sqm`, `clear_height_m`, `temperature_c` |
| `land` | land | plot area, FAR, max height | `plot_area_sqm` |
| `farm` | farm | **dunums**, wells, water rights | `area_dunums` |
| `rooftop` | rooftop | **load capacity**, access | `load_capacity_kg_sqm` |
| `parking` | land | nothing — the bay is the spec | — |
| `signage` | land | plot/panel area | `plot_area_sqm` |

Detail tables (class-table inheritance, 1:1, `ON DELETE CASCADE`):

| Table | Carries |
|---|---|
| `unit_residential_detail` | `square_m` `furnished` `has_balcony` `has_parking` `floor_number` |
| `unit_commercial_detail` | `frontage_m` `display_windows` `roller_shutter` `mezzanine_sqm` `permitted_use` `fit_out` |
| `unit_industrial_detail` | `clear_height_m` `floor_load_kg_sqm` `dock_doors` `three_phase_power` `yard_sqm` `temperature_c` |
| `unit_land_detail` | `plot_number` `plot_area_sqm` `max_far` `max_height_m` `is_corner` `has_water_meter` `has_power_meter` `current_use` |
| `unit_farm_detail` | `area_dunums` `well_count` `water_rights_m3` `greenhouse_count` `soil_kind` `planted_crop` |
| `unit_rooftop_detail` | `load_capacity_kg_sqm` `access_kind` `has_parapet` |

**Why not JSONB:** a shop's frontage is negotiated, referenced in a lease, and
compared across a portfolio. It gets a column, a type and a CHECK. The pairing is
enforced by a trigger (`unit_detail_kind_guard`, migration `0009`) so a flat cannot
carry a frontage — a constraint no blob can express.

## 3. Lease taxonomy

`lease_kind`: `residential` `commercial` `industrial` `agricultural` `short_term` `parking` `bare_land`
`billing_cycle`: `monthly` `quarterly` `semi_annual` `annual` `upfront_single`

| Kind | Allowed cycles | Default notice | Deposit cap |
|---|---|---|---|
| residential | monthly → annual | 30 d | 1 month |
| commercial | monthly → annual | 60 d | 3 months |
| industrial | monthly → annual | 90 d | 3 months |
| agricultural | quarterly → annual, upfront | 180 d | 12 months |
| short_term | upfront, monthly | 7 d | 1 month |
| parking | monthly, quarterly, upfront | 15 d | 1 month |
| bare_land | semi-annual, annual, upfront | 180 d | 12 months |

`leases_cycle_ck` makes the pairing a rule: **agricultural land cannot be billed
monthly** — that would generate twelve late fees a year against a tenant who owes
one payment. `invoicesPerYear()` derives the count from the cycle so a digest, a
statement and an arrears report cannot disagree.

## 4. Charge semantics

A charge kind answers four questions, and the answers belong to the **kind**, not
the row (`packages/core/src/taxonomy/charges.ts`):

| Kind | Bearer | Class | Refundable | VAT | Statement group |
|---|---|---|---|---|---|
| `rent` | tenant | income | no | yes | rent |
| `late_fee` | tenant | income | no | no | fees |
| `service` / `service_charge` | tenant | income | no | yes | fees |
| `deposit` | tenant | **liability** | **yes** | no | security |
| `fit_out_deposit` | tenant | **liability** | **yes** | no | security |
| `insurance` | tenant | recovery | no | no | fees |
| `utility` | tenant | recovery | no | no | utilities |
| `parking` | tenant | income | no | yes | fees |
| `cheque_bounce_fee` | tenant | income | no | no | fees |
| `vat` | tenant | **liability** | no | — | tax |
| `penalty` | tenant | income | no | no | fees |
| `other` | shared | income | no | yes | other |

`isTrustMoney(kind)` is true for exactly `deposit`, `fit_out_deposit`, `vat`:
these must never be counted as landlord revenue. `other` is the only kind that
requires a human classification before it is posted.

## 5. Work taxonomy — category → trade → floor

| Category | Trade | Severity floor | Emergency-capable | Safety guidance |
|---|---|---|---|---|
| `gas` | gas_safety | **emergency** | yes | gas_smell |
| `fire` | fire_safety | **emergency** | yes | fire |
| `electrical` | electrician | high | yes | electrical_shock |
| `sewage` | drainage | high | yes | sewage_health |
| `structural` | structural_engineer | high | yes | collapse_risk |
| `elevator` | elevator | high | yes | trapped_in_lift |
| `plumbing` | plumber | medium | yes | water_damage |
| `water` | water_tank | medium | yes | water_damage |
| `lock` | locksmith | medium | yes | locked_out |
| `generator` | generator | medium | yes | power_outage |
| `hvac` | hvac | medium | no | — |
| `appliance` | appliance_repair | low | no | — |
| `pest` | pest_control | low | no | — |
| `other` | handyman | low | no | — |
| `common_area` | cleaning | cosmetic | no | — |

`applySeverityFloor(category, claimed)` is the deterministic half of **LAW 2**: a
model may raise severity, never lower it. A calmly worded message about gas is
still an emergency, because the floor is not a judgement.

## 6. Enforcement ladder

1. **`packages/contracts`** (zod) — the shared interface; nothing crosses a process
   boundary unparsed.
2. **`packages/core`** (pure) — vocabulary, invariants, money. No clock, no network,
   no `Date.now()` (LAW 1).
3. **Postgres** — 184 FKs, 129 CHECK constraints, and triggers for the pairings an FK
   cannot express. The DB refuses what the code says is impossible.

The vocabulary exists twice on purpose (enum + TS union) and a test
(`apps/worker/src/__tests__/taxonomy.test.ts`) compares both lists **value by value,
in order**, against the live database. `taxonomy-guards.test.ts` then tries to
insert illegal rows — a flat with no building, land with one, a shop's frontage on
a flat, an agricultural lease billed monthly — and asserts Postgres refuses each.

## 7. Known gaps

- **`units.building_id` / `bedrooms` / `bathrooms` are nullable in Postgres but still
  `notNull` in the Drizzle model** (`packages/db/src/schema/m1-property.ts`). The
  database is correct; the TypeScript type is optimistic. Follow-up, not done here.
- **No person model beyond a phone.** `channel_identities.tenant_id` is the only link
  from a conversation to an entity; there is no `users ↔ tenant` edge.
- **`(channel, external_id)` is globally unique** — one number can be an identity in
  one organization only.
- **RLS is inert** — the app role is `rolsuper` + `rolbypassrls` (`BLOCKERS.md` #1).
- **`legal_flags` is data, not law.** A notice never asserts a rule; the flag exists
  so a human reviews it.
- **Detail tables are optional.** A warehouse can exist without a clear height while
  it is being surveyed; it simply cannot be published (§2.2).
