// Server-only reads for the statement screen. Org-scoped, read-only.
// Money columns come back as integer fils; no arithmetic happens here.
import { sql } from '@/lib/db';
import { shiftPeriod } from '@/lib/period';
import type { OwnerShare } from '@aqar/contracts';
import { DEFAULT_MANAGEMENT_FEE_BPS } from './lib';
import type { ExpenseLine, RentLine } from './lib';

export interface OwnerOption {
  readonly id: string;
  readonly nameEn: string;
  readonly nameAr: string;
}
export interface PropertyOption {
  readonly id: string;
  readonly name: string;
}

export async function listOwners(orgId: string): Promise<OwnerOption[]> {
  const rows = await sql`
    SELECT id, full_name_en, full_name_ar FROM owners
    WHERE organization_id = ${orgId} ORDER BY full_name_en`;
  return rows.map((r) => ({
    id: String(r['id']),
    nameEn: String(r['full_name_en']),
    nameAr: String(r['full_name_ar']),
  }));
}

export async function listProperties(orgId: string): Promise<PropertyOption[]> {
  const rows = await sql`
    SELECT id, name FROM properties WHERE organization_id = ${orgId} ORDER BY name`;
  return rows.map((r) => ({ id: String(r['id']), name: String(r['name']) }));
}

/** Latest period with charges — the default selection lands on real data. */
export async function latestDataPeriod(orgId: string): Promise<string | null> {
  const rows = await sql`SELECT MAX(period) AS p FROM charges WHERE organization_id = ${orgId}`;
  const p = rows[0]?.['p'];
  return typeof p === 'string' ? p : null;
}

export async function rentLines(
  orgId: string,
  propertyId: string,
  period: string,
): Promise<RentLine[]> {
  const rows = await sql`
    SELECT l.id AS lease_id, u.unit_number,
      COALESCE(tn.full_name_ar, tn.full_name_en, '—') AS tenant_name,
      c.amount_fils AS billed, COALESCE(pa.paid, 0)::int AS collected
    FROM charges c
    JOIN leases l ON l.id = c.lease_id
    JOIN units u ON u.id = l.unit_id
    LEFT JOIN LATERAL (
      SELECT t.full_name_ar, t.full_name_en FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id = l.id ORDER BY lt.is_primary DESC LIMIT 1
    ) tn ON true
    LEFT JOIN LATERAL (
      SELECT SUM(x.amount_fils) AS paid FROM payment_allocations x WHERE x.charge_id = c.id
    ) pa ON true
    WHERE c.organization_id = ${orgId} AND l.property_id = ${propertyId}
      AND c.period = ${period} AND c.kind = 'rent'
    ORDER BY u.unit_number, c.id`;
  return rows.map((r) => ({
    leaseId: String(r['lease_id']),
    unitLabel: String(r['unit_number']),
    tenantName: String(r['tenant_name']),
    billedFils: Number(r['billed']),
    collectedFils: Number(r['collected']),
  }));
}

/** Real completed-work costs only. Empty completions => zero expenses, shown honestly. */
export async function expenseLines(
  orgId: string,
  propertyId: string,
  period: string,
): Promise<ExpenseLine[]> {
  const start = `${period}-01`;
  const end = `${shiftPeriod(period, 1)}-01`;
  const rows = await sql`
    SELECT co.id, co.cost_fils, co.completed_at, co.notes, tk.id AS ticket_id
    FROM completions co
    JOIN tickets tk ON tk.id = co.ticket_id
    WHERE co.organization_id = ${orgId} AND tk.property_id = ${propertyId}
      AND co.completed_at >= ${start}::date AND co.completed_at < ${end}::date
    ORDER BY co.completed_at, co.id`;
  return rows.map((r) => ({
    workOrderId: String(r['id']),
    label:
      typeof r['notes'] === 'string' && r['notes'].length > 0
        ? r['notes']
        : `ticket ${String(r['ticket_id']).slice(0, 8)}`,
    completedISO: (r['completed_at'] instanceof Date
      ? r['completed_at'].toISOString()
      : String(r['completed_at'])
    ).slice(0, 10),
    costFils: Number(r['cost_fils']),
  }));
}

export async function propertyShares(orgId: string, propertyId: string): Promise<OwnerShare[]> {
  const rows = await sql`
    SELECT owner_id, share_bps FROM ownership_shares
    WHERE organization_id = ${orgId} AND property_id = ${propertyId}
    ORDER BY owner_id`;
  return rows.map((r) => ({ ownerId: String(r['owner_id']), shareBps: Number(r['share_bps']) }));
}

/** Most recent recorded fee rate for the property; documented fallback otherwise. */
export async function feeBasisBps(
  orgId: string,
  propertyId: string,
): Promise<{ bps: number; recorded: boolean }> {
  const rows = await sql`
    SELECT basis_bps FROM management_fees
    WHERE organization_id = ${orgId} AND property_id = ${propertyId}
    ORDER BY period DESC LIMIT 1`;
  const r = rows[0];
  return r === undefined
    ? { bps: DEFAULT_MANAGEMENT_FEE_BPS, recorded: false }
    : { bps: Number(r['basis_bps']), recorded: true };
}

export interface ExistingStatement {
  readonly id: string;
  readonly issuedAtISO: string;
  readonly grossRentFils: number;
  readonly expensesFils: number;
  readonly managementFeeFils: number;
  readonly netFils: number;
}

export async function existingStatement(
  orgId: string,
  propertyId: string,
  period: string,
): Promise<ExistingStatement | null> {
  const rows = await sql`
    SELECT id, issued_at, gross_rent_fils, expenses_fils, management_fee_fils, net_fils
    FROM owner_statements
    WHERE organization_id = ${orgId} AND property_id = ${propertyId} AND period = ${period}
    LIMIT 1`;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: String(r['id']),
    issuedAtISO:
      r['issued_at'] instanceof Date ? r['issued_at'].toISOString() : String(r['issued_at']),
    grossRentFils: Number(r['gross_rent_fils']),
    expensesFils: Number(r['expenses_fils']),
    managementFeeFils: Number(r['management_fee_fils']),
    netFils: Number(r['net_fils']),
  };
}

export async function existingDistributionOwnerIds(
  orgId: string,
  propertyId: string,
  period: string,
): Promise<Set<string>> {
  const rows = await sql`
    SELECT owner_id FROM distributions
    WHERE organization_id = ${orgId} AND property_id = ${propertyId} AND period = ${period}`;
  return new Set(rows.map((r) => String(r['owner_id'])));
}
