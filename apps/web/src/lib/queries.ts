import { sql } from './db';

export interface UnitRow { id: string; status: string; propertyId: string }
export interface ChargeRow {
  id: string; leaseId: string; period: string; kind: string; amountFils: number;
  dueDate: string; tenantName: string; unitLabel: string; propertyName: string; paidFils: number;
}
export interface TicketRow {
  id: string; status: string; emergencyFlag: boolean; openedAt: string; channel: string;
  category: string | null; severity: string | null; confidence: number | null;
  propertyName: string; unitLabel: string | null; text: string;
}

export async function unitsByStatus(orgId: string): Promise<UnitRow[]> {
  const rows = await sql`
    SELECT u.id, u.status, u.property_id FROM units u
    JOIN properties p ON p.id = u.property_id WHERE p.org_id = ${orgId}`;
  return rows.map((r) => ({ id: String(r['id']), status: String(r['status']), propertyId: String(r['property_id']) }));
}

export async function chargesForPeriod(orgId: string, period: string): Promise<ChargeRow[]> {
  const rows = await sql`
    SELECT c.id, c.lease_id, c.period, c.kind, c.amount_fils, c.due_date,
      COALESCE(t.name_ar, t.name_en, '—') AS tenant_name,
      u.label AS unit_label, p.name AS property_name,
      COALESCE((SELECT SUM(pa.amount_fils) FROM payment_allocations pa WHERE pa.charge_id = c.id), 0) AS paid_fils
    FROM charges c
    JOIN leases l ON l.id = c.lease_id
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN lease_tenants lt ON lt.lease_id = l.id
    LEFT JOIN tenants t ON t.id = lt.tenant_id
    WHERE p.org_id = ${orgId} AND c.period = ${period}
    ORDER BY c.due_date, c.id`;
  return rows.map((r) => ({
    id: String(r['id']), leaseId: String(r['lease_id']), period: String(r['period']),
    kind: String(r['kind']), amountFils: Number(r['amount_fils']), dueDate: String(r['due_date']).slice(0, 10),
    tenantName: String(r['tenant_name']), unitLabel: String(r['unit_label']),
    propertyName: String(r['property_name']), paidFils: Number(r['paid_fils']),
  }));
}

export async function collectionTotals(orgId: string, period: string): Promise<{ billed: number; collected: number }> {
  const rows = await sql`
    SELECT COALESCE(SUM(c.amount_fils), 0) AS billed,
      COALESCE(SUM(pa.amount_fils), 0) AS collected
    FROM charges c
    JOIN leases l ON l.id = c.lease_id
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN payment_allocations pa ON pa.charge_id = c.id
    WHERE p.org_id = ${orgId} AND c.period = ${period}`;
  const r = rows[0];
  return { billed: Number(r?.['billed'] ?? 0), collected: Number(r?.['collected'] ?? 0) };
}

export async function ticketsForOrg(orgId: string, limit = 50): Promise<TicketRow[]> {
  const rows = await sql`
    SELECT tk.id, tk.status, tk.emergency_flag, tk.opened_at, tk.channel, tk.text,
      cl.category, cl.severity, cl.confidence, p.name AS property_name, u.label AS unit_label
    FROM tickets tk
    JOIN properties p ON p.id = tk.property_id
    LEFT JOIN units u ON u.id = tk.unit_id
    LEFT JOIN classifications cl ON cl.ticket_id = tk.id
    WHERE tk.org_id = ${orgId}
    ORDER BY tk.emergency_flag DESC, tk.opened_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: String(r['id']), status: String(r['status']), emergencyFlag: Boolean(r['emergency_flag']),
    openedAt: String(r['opened_at']), channel: String(r['channel']), text: String(r['text'] ?? ''),
    category: r['category'] === null ? null : String(r['category']),
    severity: r['severity'] === null ? null : String(r['severity']),
    confidence: r['confidence'] === null ? null : Number(r['confidence']),
    propertyName: String(r['property_name']),
    unitLabel: r['unit_label'] === null ? null : String(r['unit_label']),
  }));
}

export async function ticketMessages(ticketId: string): Promise<Array<{ body: string; sender: string; at: string }>> {
  const rows = await sql`
    SELECT body, sender, created_at FROM ticket_messages WHERE ticket_id = ${ticketId} ORDER BY created_at`;
  return rows.map((r) => ({ body: String(r['body']), sender: String(r['sender']), at: String(r['created_at']) }));
}

export async function orgName(orgId: string): Promise<string> {
  const rows = await sql`SELECT name FROM organizations WHERE id = ${orgId} LIMIT 1`;
  return String(rows[0]?.['name'] ?? '—');
}
