// Read-only data access for the console. Every query is scoped by organization_id.
// Column names reconciled against packages/db/src/schema (the source of truth).
import { sql } from './db';
import type { UnitStatus } from '@aqar/core';

export interface UnitRow { id: string; status: UnitStatus; propertyId: string }
export interface ChargeRow {
  id: string; leaseId: string; period: string; kind: string;
  amountFils: number; dueDate: string; paidFils: number;
  tenantName: string; unitLabel: string; propertyName: string;
}
export interface TicketRow {
  id: string; status: string; emergencyFlag: boolean; openedAt: string; channel: string;
  text: string; category: string | null; severity: string | null; confidence: number | null;
  unitLabel: string | null; propertyName: string;
}

const UNIT_STATUSES: readonly string[] = ['occupied', 'vacant', 'turnover', 'unavailable'];
function asUnitStatus(value: unknown): UnitStatus {
  const s = String(value);
  return UNIT_STATUSES.includes(s) ? (s as UnitStatus) : 'unavailable';
}

export async function unitsByStatus(orgId: string): Promise<UnitRow[]> {
  const rows = await sql`
    SELECT id, status, property_id FROM units WHERE organization_id = ${orgId}`;
  return rows.map((r) => ({ id: String(r['id']), status: asUnitStatus(r['status']), propertyId: String(r['property_id']) }));
}

export async function chargesForPeriod(orgId: string, period: string): Promise<ChargeRow[]> {
  const rows = await sql`
    SELECT c.id, c.lease_id, c.period, c.kind, c.amount_fils, c.due_date,
      COALESCE(pa.paid, 0)::int AS paid_fils,
      COALESCE(tn.full_name_ar, tn.full_name_en, '—') AS tenant_name,
      u.unit_number AS unit_label, p.name AS property_name
    FROM charges c
    JOIN leases l ON l.id = c.lease_id
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = l.property_id
    LEFT JOIN LATERAL (
      SELECT t.full_name_ar, t.full_name_en FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id = l.id ORDER BY lt.is_primary DESC LIMIT 1
    ) tn ON true
    LEFT JOIN LATERAL (
      SELECT SUM(x.amount_fils) AS paid FROM payment_allocations x WHERE x.charge_id = c.id
    ) pa ON true
    WHERE c.organization_id = ${orgId} AND c.period = ${period}
    ORDER BY c.due_date, u.unit_number`;
  return rows.map((r) => ({
    id: String(r['id']), leaseId: String(r['lease_id']), period: String(r['period']),
    kind: String(r['kind']), amountFils: Number(r['amount_fils']),
    dueDate: (r['due_date'] instanceof Date ? r['due_date'].toISOString() : String(r['due_date'])).slice(0, 10),
    paidFils: Number(r['paid_fils']), tenantName: String(r['tenant_name']),
    unitLabel: String(r['unit_label']), propertyName: String(r['property_name']),
  }));
}

// Scalar subqueries: a JOIN to allocations would fan out charge rows and inflate SUM(amount).
export async function collectionTotals(orgId: string, period: string): Promise<{ billed: number; collected: number }> {
  const rows = await sql`
    SELECT
      (SELECT COALESCE(SUM(amount_fils), 0)::int FROM charges
        WHERE organization_id = ${orgId} AND period = ${period}) AS billed,
      (SELECT COALESCE(SUM(pa.amount_fils), 0)::int FROM payment_allocations pa
        JOIN charges c ON c.id = pa.charge_id
        WHERE c.organization_id = ${orgId} AND c.period = ${period}) AS collected`;
  const r = rows[0];
  return { billed: Number(r?.['billed'] ?? 0), collected: Number(r?.['collected'] ?? 0) };
}

export async function ticketCounts(orgId: string): Promise<{ open: number; emergencies: number }> {
  const rows = await sql`
    SELECT count(*) FILTER (WHERE status NOT IN ('closed','cancelled'))::int AS open,
           count(*) FILTER (WHERE emergency_flag AND status NOT IN ('closed','cancelled'))::int AS emergencies
    FROM tickets WHERE organization_id = ${orgId}`;
  const r = rows[0] ?? { open: 0, emergencies: 0 };
  return { open: Number(r['open']), emergencies: Number(r['emergencies']) };
}

export async function ticketsForOrg(orgId: string, limit: number): Promise<TicketRow[]> {
  const rows = await sql`
    SELECT tk.id, tk.status, tk.emergency_flag, tk.opened_at, tk.channel, tk.body AS text,
      cl.category, cl.severity, cl.confidence,
      u.unit_number AS unit_label, p.name AS property_name
    FROM tickets tk
    JOIN properties p ON p.id = tk.property_id
    LEFT JOIN units u ON u.id = tk.unit_id
    LEFT JOIN LATERAL (
      SELECT category, severity, confidence FROM classifications
      WHERE ticket_id = tk.id ORDER BY created_at DESC LIMIT 1
    ) cl ON true
    WHERE tk.organization_id = ${orgId}
    ORDER BY tk.emergency_flag DESC, tk.opened_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: String(r['id']), status: String(r['status']), emergencyFlag: Boolean(r['emergency_flag']),
    openedAt: String(r['opened_at']), channel: String(r['channel']), text: String(r['text']),
    category: r['category'] === null ? null : String(r['category']),
    severity: r['severity'] === null ? null : String(r['severity']),
    confidence: r['confidence'] === null ? null : Number(r['confidence']),
    unitLabel: r['unit_label'] === null ? null : String(r['unit_label']),
    propertyName: String(r['property_name']),
  }));
}

export async function ticketMessages(ticketId: string): Promise<{ body: string; sender: string; at: string }[]> {
  const rows = await sql`
    SELECT body, direction AS sender, sent_at AS at FROM ticket_messages
    WHERE ticket_id = ${ticketId} ORDER BY sent_at`;
  return rows.map((r) => ({ body: String(r['body']), sender: String(r['sender']), at: String(r['at']) }));
}

export async function orgName(orgId: string): Promise<string> {
  const rows = await sql`SELECT name FROM organizations WHERE id = ${orgId}`;
  return rows[0] === undefined ? 'Aqar' : String(rows[0]['name']);
}
