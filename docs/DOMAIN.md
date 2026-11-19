# Domain — the nine modules and their invariants

Money unit: **integer fils**. 1 JOD = 1000 fils, JOD has 3 decimals.
No float arithmetic on money anywhere. Dates are inputs to core, never read
from a wall clock inside core.

## M1 Portfolio & Units
organization → property → building → unit; amenities; meters
(water/electric/generator). Jordanian addressing: district + building name +
floor + unit, not US street/ZIP.
*Invariant:* unit status is one of vacant|occupied|turnover|unavailable;
vacancy aging derives from status history, never hand-set.

## M2 Leasing & Applicants
listing → inquiry → showing → application → screening → decision.
*Invariant:* the agent never approves/rejects an applicant and never reasons
about protected characteristics; every applicant-facing message is logged;
decisions require a human signature.

## M3 Leases
lease (rent_fils, deposit_fils, due_day 1..28, late_fee_rule, escalation_rule)
→ lease_tenant (many tenants) → addenda → renewal offers → notices.
*Invariant:* proration, escalation, renewal math, deposit accounting and
notice clocks are pure property-tested functions. PDF extraction returns a
*proposal* with per-field confidence + source page; a human confirms every
field before save.

## M4 Rent Ledger & Collections (the heart)
charge (idempotent per lease+period+kind) → payment → payment_allocation;
bank_import/bank_line/match_suggestion; late_fee; credit_note;
journal_entry/journal_line/account; period_lock.
*Invariants:*
- charge status is DERIVED from money (open|partial|paid|overdue), never stored;
- allocation waterfall: oldest outstanding first unless a human-confirmed
  reference names a period; partials supported; allocations sum to the payment;
- every financial event posts balanced double-entry lines; unbalanced = throw;
- corrections are reversals only; locked periods reject writes;
- bank matching is payer-identity + amount + date tolerance, NOT reference;
  overlapping statements dedupe by line fingerprint; every match undoable;
- cheque lifecycle received → deposited → cleared|bounced; bounce reverses
  allocations, re-opens the charge, raises a collections task.

## M5 Maintenance / Work Orders (the agentic core)
ticket → classification → responsibility → work_order → dispatch →
vendor_quote → completion → sla_clock; ticket_message; attachment.
*Invariants:* emergency = deterministic pre-check OR model flag, sticky for
the ticket's life; 5 severity levels; SLA clocks come from a configurable
service-standard pack, never hard-coded statute; emergency banner cannot be
dismissed by an agent.

## M6 Vendors
vendor (trades, coverage, rates, insurance cert + expiry, licence) →
vendor_job → quote → invoice → performance_score.
*Invariant:* scoring is deterministic (completion, on-time, cost variance,
rework); the agent never awards work outside policy (allow-list, NTE, N-of-M).

## M7 Owner Accounting
owner → ownership_share (bps, sum exactly 10000) → owner_statement →
distribution → management_fee → owner_approval (N-of-M) → trust_account.
*Invariants:* trust and operating cash NEVER commingle (tested); share
splitting uses largest-remainder so no fils is lost (property-tested);
the agent never moves money.

## M8 Compliance & Documents
document (versioned, S3) → inspection → insurance_policy → certification →
notice_template → legal_flag → service_standard.
*Invariant:* no legal conclusions to tenants; jurisdiction rules are data
flagged for human review; notices are drafts until a human approves.

## M9 Reporting & Analytics
Deterministic metrics in core: occupancy, delinquency, collection rate, NOI,
work-order aging, MTTR, lease-roll forecast, vendor spend, per-property P&L.
*Invariant:* the NL query box compiles a question into a parameterised
READ-ONLY query; the LLM picks the shape, the database produces every number,
and the answer always shows the underlying rows.
