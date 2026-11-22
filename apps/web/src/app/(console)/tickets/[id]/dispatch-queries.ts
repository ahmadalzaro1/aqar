// Reads for the M5 dispatch board on a ticket.
//
// Every query is scoped by organization_id as well as by id: the console is
// multi-tenant and an id from another org must read as "not found", not as
// someone else's job.
import { sql } from '@/lib/db';
import {
  CATEGORY_PROFILES,
  canonicalTrade,
  defaultServiceStandard,
  eligibleVendors,
  rankQuotes,
  tradeSpellings,
  vendorScore,
  type DispatchVendor,
  type Severity,
  type TicketCategory,
} from '@aqar/core';
import type { ServiceStandard } from '@aqar/contracts';

/**
 * The org's spend policy for work orders, in fils. Two numbers, two questions:
 * below `autoApproveUnderFils` nobody has to sign; above `nteCeilingFils` the
 * job cannot be authorised at all without renegotiating the policy itself.
 */
export interface SpendPolicy {
  readonly autoApproveUnderFils: number;
  readonly nteCeilingFils: number;
}

/** Used only when the org has no policy row: 100 JOD auto, 500 JOD hard cap. */
export const DEFAULT_SPEND_POLICY: SpendPolicy = {
  autoApproveUnderFils: 100_000,
  nteCeilingFils: 500_000,
};

export interface DispatchContext {
  readonly ticketId: string;
  readonly status: string;
  readonly openedAtISO: string;
  readonly emergency: boolean;
  readonly category: TicketCategory;
  /** severity from the latest classification, floored by the category profile */
  readonly severity: Severity;
  readonly responsibility: string | null;
  readonly sla: {
    readonly responseDueAt: string | null;
    readonly resolutionDueAt: string | null;
    readonly respondedAt: string | null;
    readonly resolvedAt: string | null;
  } | null;
}

export interface WorkOrderRow {
  readonly id: string;
  readonly status: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly scopeMd: string;
  readonly nteFils: number | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
}

export interface DispatchRow {
  readonly id: string;
  readonly status: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly offeredAt: string;
  readonly acceptedAt: string | null;
  readonly note: string | null;
}

export interface QuoteRow {
  readonly id: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly amountFils: number;
  readonly leadTimeDays: number | null;
  readonly receivedAt: string;
  readonly selected: boolean;
}

export interface DispatchBoard {
  readonly workOrders: readonly WorkOrderRow[];
  readonly dispatches: readonly DispatchRow[];
  readonly quotes: readonly QuoteRow[];
}

export interface RosterVendor extends DispatchVendor {
  readonly phone: string | null;
  readonly trades: readonly string[];
}

const SEVERITY_RANK: readonly Severity[] = ['cosmetic', 'low', 'medium', 'high', 'emergency'];

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Severity is floored by the category: a gas report is never below emergency,
 * however calmly it was described. The floor comes from the taxonomy, not from
 * a copy of it — one table decides both triage and dispatch.
 */
function flooredSeverity(category: TicketCategory, classified: unknown): Severity {
  const floor = SEVERITY_RANK.indexOf(CATEGORY_PROFILES[category].severityFloor);
  const seen = SEVERITY_RANK.indexOf(String(classified) as Severity);
  const index = seen < 0 ? floor : Math.max(floor, seen);
  return SEVERITY_RANK[index] ?? 'medium';
}

export async function dispatchContext(
  orgId: string,
  ticketId: string,
): Promise<DispatchContext | null> {
  const rows = await sql`
    SELECT tk.id, tk.status, tk.opened_at, tk.emergency_flag,
      cl.category, cl.severity, r.responsibility,
      sc.response_due_at, sc.resolution_due_at, sc.responded_at, sc.resolved_at
    FROM tickets tk
    LEFT JOIN LATERAL (
      SELECT category, severity FROM classifications
      WHERE ticket_id = tk.id ORDER BY created_at DESC LIMIT 1
    ) cl ON true
    LEFT JOIN LATERAL (
      SELECT responsibility FROM responsibilities
      WHERE ticket_id = tk.id ORDER BY created_at DESC LIMIT 1
    ) r ON true
    LEFT JOIN sla_clocks sc ON sc.ticket_id = tk.id AND sc.organization_id = tk.organization_id
    WHERE tk.id = ${ticketId} AND tk.organization_id = ${orgId}
    LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  const category = String(row['category'] ?? 'other') as TicketCategory;
  const openedAtISO = asIso(row['opened_at']) ?? new Date(0).toISOString();
  return {
    ticketId: String(row['id']),
    status: String(row['status']),
    openedAtISO,
    emergency: Boolean(row['emergency_flag']),
    category,
    severity: flooredSeverity(category, row['severity']),
    responsibility: row['responsibility'] === null ? null : String(row['responsibility']),
    sla:
      row['response_due_at'] === null && row['resolution_due_at'] === null
        ? null
        : {
            responseDueAt: asIso(row['response_due_at']),
            resolutionDueAt: asIso(row['resolution_due_at']),
            respondedAt: asIso(row['responded_at']),
            resolvedAt: asIso(row['resolved_at']),
          },
  };
}

/**
 * The roster as a dispatch decision sees it: allow-listed vendors with their
 * trade coverage and a score derived from their own job history. A vendor with
 * no jobs scores null rather than zero — unproven is not bad.
 */
export async function vendorRoster(orgId: string): Promise<readonly RosterVendor[]> {
  const rows = await sql`
    SELECT v.id, v.name_en, v.name_ar, v.phone, v.trades, v.allow_listed,
      v.insurance_cert_expiry, v.rating,
      COALESCE(j.jobs_total, 0) AS jobs_total,
      COALESCE(j.jobs_completed, 0) AS jobs_completed,
      COALESCE(j.jobs_on_time, 0) AS jobs_on_time,
      COALESCE(j.variance_bps_sum, 0) AS variance_bps_sum
    FROM vendors v
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS jobs_total,
        count(*) FILTER (WHERE status = 'completed')::int AS jobs_completed,
        count(*) FILTER (
          WHERE status = 'completed' AND completed_at IS NOT NULL AND scheduled_at IS NOT NULL
            AND completed_at <= scheduled_at
        )::int AS jobs_on_time,
        COALESCE(sum(
          CASE WHEN quoted_fils > 0 AND actual_fils IS NOT NULL
          THEN round((actual_fils - quoted_fils) * 10000.0 / quoted_fils)::int END
        ), 0)::int AS variance_bps_sum
      FROM vendor_jobs
      WHERE vendor_id = v.id AND organization_id = v.organization_id
    ) j ON true
    WHERE v.organization_id = ${orgId}
    ORDER BY v.name_en`;
  return rows.map((row) => {
    const trades = Array.isArray(row['trades']) ? (row['trades'] as string[]) : [];
    const rating = row['rating'] === null ? null : Number(row['rating']);
    return {
      id: String(row['id']),
      nameEn: String(row['name_en']),
      nameAr: row['name_ar'] === null ? null : String(row['name_ar']),
      phone: row['phone'] === null ? null : String(row['phone']),
      trades,
      allowListed: Boolean(row['allow_listed']),
      insuranceCertExpiry: asIso(row['insurance_cert_expiry']),
      rating: rating === null || Number.isNaN(rating) ? null : rating,
      score: vendorScore({
        jobsTotal: Number(row['jobs_total']),
        jobsCompleted: Number(row['jobs_completed']),
        jobsOnTime: Number(row['jobs_on_time']),
        costVarianceBpsSum: Number(row['variance_bps_sum']),
        jobsReworked: 0,
      }),
    };
  });
}

/**
 * Every word the roster might use for a trade.
 *
 * This used to be derived by scanning `CATEGORY_PROFILES` for the categories
 * whose trade matched, which found the tenant's words (`plumbing`) but not the
 * suppliers' (`Plumbing Works`) and not Arabic («سباكة») — three sources of
 * truth for one question. It now asks the canonical table in core, which is the
 * only place the vocabulary lives.
 */
export function tradeAliases(trade: string): readonly string[] {
  const canonical = canonicalTrade(trade);
  return canonical === null ? [] : tradeSpellings(canonical);
}

/** Vendors that may be offered this trade today, best first. */
export async function eligibleRoster(
  orgId: string,
  trade: string,
  onDateISO: string,
): Promise<readonly RosterVendor[]> {
  const roster = await vendorRoster(orgId);
  const byId = new Map(roster.map((v) => [v.id, v]));
  return eligibleVendors(roster, {
    trade,
    onDate: onDateISO,
    aliases: tradeAliases(trade),
  })
    .map((v) => byId.get(v.id))
    .filter((v): v is RosterVendor => v !== undefined);
}

export async function dispatchBoard(orgId: string, ticketId: string): Promise<DispatchBoard> {
  const workOrders = await sql`
    SELECT wo.id, wo.status, wo.vendor_id, wo.scope_md, wo.nte_fils, wo.approved_at, wo.created_at,
      COALESCE(v.name_ar, v.name_en) AS vendor_name
    FROM work_orders wo
    JOIN vendors v ON v.id = wo.vendor_id
    WHERE wo.ticket_id = ${ticketId} AND wo.organization_id = ${orgId}
    ORDER BY wo.created_at DESC`;
  const dispatches = await sql`
    SELECT d.id, d.status, d.vendor_id, d.offered_at, d.accepted_at, d.note,
      COALESCE(v.name_ar, v.name_en) AS vendor_name
    FROM dispatches d
    JOIN vendors v ON v.id = d.vendor_id
    WHERE d.ticket_id = ${ticketId} AND d.organization_id = ${orgId}
    ORDER BY d.offered_at DESC`;
  const quotes = await sql`
    SELECT q.id, q.vendor_id, q.amount_fils, q.lead_time_days, q.received_at, q.selected,
      COALESCE(v.name_ar, v.name_en) AS vendor_name
    FROM vendor_quotes q
    JOIN vendors v ON v.id = q.vendor_id
    WHERE q.ticket_id = ${ticketId} AND q.organization_id = ${orgId}`;

  const ranked: QuoteRow[] = rankQuotes(
    quotes.map((row) => ({
      id: String(row['id']),
      vendorId: String(row['vendor_id']),
      amountFils: Number(row['amount_fils']),
      leadTimeDays: row['lead_time_days'] === null ? null : Number(row['lead_time_days']),
      receivedAt: asIso(row['received_at']) ?? new Date(0).toISOString(),
    })),
  ).map((rankedQuote) => {
    const source = quotes.find((row) => String(row['id']) === rankedQuote.id);
    return {
      ...rankedQuote,
      vendorName: source === undefined ? '' : String(source['vendor_name']),
      selected: source === undefined ? false : Boolean(source['selected']),
    };
  });

  return {
    workOrders: workOrders.map((row) => ({
      id: String(row['id']),
      status: String(row['status']),
      vendorId: String(row['vendor_id']),
      vendorName: String(row['vendor_name']),
      scopeMd: String(row['scope_md']),
      nteFils: row['nte_fils'] === null ? null : Number(row['nte_fils']),
      approvedAt: asIso(row['approved_at']),
      createdAt: asIso(row['created_at']) ?? new Date(0).toISOString(),
    })),
    dispatches: dispatches.map((row) => ({
      id: String(row['id']),
      status: String(row['status']),
      vendorId: String(row['vendor_id']),
      vendorName: String(row['vendor_name']),
      offeredAt: asIso(row['offered_at']) ?? new Date(0).toISOString(),
      acceptedAt: asIso(row['accepted_at']),
      note: row['note'] === null ? null : String(row['note']),
    })),
    quotes: ranked,
  };
}

/** The org's spend policy for work orders. Missing or malformed keys fall back. */
export async function spendPolicy(orgId: string): Promise<SpendPolicy> {
  const rows = await sql`
    SELECT limits FROM policy_limits WHERE organization_id = ${orgId} LIMIT 1`;
  const limits = rows[0]?.['limits'];
  if (limits === null || limits === undefined || typeof limits !== 'object') {
    return DEFAULT_SPEND_POLICY;
  }
  const source = limits as Record<string, unknown>;
  const readFils = (key: string, fallback: number): number => {
    const raw = source[key];
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    autoApproveUnderFils: readFils(
      'autoApproveUnderFils',
      DEFAULT_SPEND_POLICY.autoApproveUnderFils,
    ),
    nteCeilingFils: readFils('nteCeilingFils', DEFAULT_SPEND_POLICY.nteCeilingFils),
  };
}

/** The org's default service standard, or the conservative Jordan default. */
export async function serviceStandardFor(orgId: string): Promise<ServiceStandard> {
  const rows = await sql`
    SELECT id, name, property_class, clocks FROM service_standards
    WHERE organization_id = ${orgId} AND is_default = true LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return defaultServiceStandard();
  const clocks = row['clocks'];
  if (clocks === null || typeof clocks !== 'object') return defaultServiceStandard();
  return {
    id: String(row['id']),
    name: String(row['name']),
    propertyClass: String(row['property_class']),
    clocks: clocks as ServiceStandard['clocks'],
  };
}
