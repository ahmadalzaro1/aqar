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

// ---------------------------------------------------------------- portfolio

export interface PropertyRow {
  id: string; name: string; nameAr: string; district: string | null; city: string | null;
  units: number; occupied: number; vacant: number; buildings: number; marketRentFils: number;
}

export async function portfolioByProperty(orgId: string): Promise<PropertyRow[]> {
  const rows = await sql`
    SELECT p.id, p.name, p.name_ar, p.district, p.city,
      count(u.id)::int AS units,
      count(u.id) FILTER (WHERE u.status = 'occupied')::int AS occupied,
      count(u.id) FILTER (WHERE u.status = 'vacant')::int AS vacant,
      (SELECT count(*)::int FROM buildings b WHERE b.property_id = p.id) AS buildings,
      coalesce(sum(u.market_rent_fils), 0)::bigint AS market_rent
    FROM properties p LEFT JOIN units u ON u.property_id = p.id
    WHERE p.organization_id = ${orgId}
    GROUP BY p.id ORDER BY p.name`;
  return rows.map((r) => ({
    id: String(r['id']), name: String(r['name']), nameAr: String(r['name_ar']),
    district: r['district'] === null ? null : String(r['district']),
    city: r['city'] === null ? null : String(r['city']),
    units: Number(r['units']), occupied: Number(r['occupied']), vacant: Number(r['vacant']),
    buildings: Number(r['buildings']), marketRentFils: Number(r['market_rent']),
  }));
}

export interface VacantUnitRow {
  id: string; unitNumber: string; floor: number | null; bedrooms: number | null;
  areaSqm: number | null; marketRentFils: number; propertyName: string; status: string;
}

export async function unitsNeedingTenant(orgId: string): Promise<VacantUnitRow[]> {
  const rows = await sql`
    SELECT u.id, u.unit_number, u.floor, u.bedrooms, u.area_sqm, u.market_rent_fils,
           u.status, p.name AS property_name
    FROM units u JOIN properties p ON p.id = u.property_id
    WHERE u.organization_id = ${orgId} AND u.status IN ('vacant', 'turnover')
    ORDER BY p.name, u.unit_number`;
  return rows.map((r) => ({
    id: String(r['id']), unitNumber: String(r['unit_number']),
    floor: r['floor'] === null ? null : Number(r['floor']),
    bedrooms: r['bedrooms'] === null ? null : Number(r['bedrooms']),
    areaSqm: r['area_sqm'] === null ? null : Number(r['area_sqm']),
    marketRentFils: Number(r['market_rent_fils']), propertyName: String(r['property_name']),
    status: String(r['status']),
  }));
}

export interface LeaseRow {
  id: string; status: string; startDate: string; endDate: string; rentFils: number;
  depositFils: number; dueDay: number; unitNumber: string; propertyName: string;
  tenantEn: string; tenantAr: string;
}

export async function leasesForOrg(orgId: string): Promise<LeaseRow[]> {
  const rows = await sql`
    SELECT l.id, l.status, l.start_date, l.end_date, l.rent_fils, l.deposit_fils, l.due_day,
           u.unit_number, p.name AS property_name,
           coalesce(t.full_name_en, '—') AS tenant_en, coalesce(t.full_name_ar, '—') AS tenant_ar
    FROM leases l
    JOIN units u ON u.id = l.unit_id
    JOIN properties p ON p.id = l.property_id
    LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.is_primary = true
    LEFT JOIN tenants t ON t.id = lt.tenant_id
    WHERE l.organization_id = ${orgId}
    ORDER BY l.end_date, p.name, u.unit_number`;
  return rows.map((r) => ({
    id: String(r['id']), status: String(r['status']),
    startDate: String(r['start_date']).slice(0, 10), endDate: String(r['end_date']).slice(0, 10),
    rentFils: Number(r['rent_fils']), depositFils: Number(r['deposit_fils']), dueDay: Number(r['due_day']),
    unitNumber: String(r['unit_number']), propertyName: String(r['property_name']),
    tenantEn: String(r['tenant_en']), tenantAr: String(r['tenant_ar']),
  }));
}

// ------------------------------------------------------------ vendors/owners

export interface VendorRow {
  id: string; nameEn: string; nameAr: string; phone: string | null; email: string | null;
  trades: string[]; coverage: string[]; rating: number | null; allowListed: boolean;
  insuranceExpiry: string | null;
}

export async function vendorsForOrg(orgId: string): Promise<VendorRow[]> {
  const rows = await sql`
    SELECT id, name_en, name_ar, phone, email, trades, coverage_areas, rating,
           allow_listed, insurance_cert_expiry
    FROM vendors WHERE organization_id = ${orgId} ORDER BY name_en`;
  return rows.map((r) => ({
    id: String(r['id']), nameEn: String(r['name_en']), nameAr: String(r['name_ar']),
    phone: r['phone'] === null ? null : String(r['phone']),
    email: r['email'] === null ? null : String(r['email']),
    trades: Array.isArray(r['trades']) ? (r['trades'] as string[]) : [],
    coverage: Array.isArray(r['coverage_areas']) ? (r['coverage_areas'] as string[]) : [],
    rating: r['rating'] === null ? null : Number(r['rating']),
    allowListed: Boolean(r['allow_listed']),
    insuranceExpiry: r['insurance_cert_expiry'] === null ? null : String(r['insurance_cert_expiry']).slice(0, 10),
  }));
}

export interface OwnerRow {
  id: string; nameEn: string; nameAr: string; phone: string | null; email: string | null;
  shareBps: number; properties: number;
}

export async function ownersForOrg(orgId: string): Promise<OwnerRow[]> {
  const rows = await sql`
    SELECT o.id, o.full_name_en, o.full_name_ar, o.phone, o.email,
      coalesce(sum(s.share_bps), 0)::int AS share_bps,
      count(DISTINCT s.property_id)::int AS properties
    FROM owners o LEFT JOIN ownership_shares s ON s.owner_id = o.id
    WHERE o.organization_id = ${orgId}
    GROUP BY o.id ORDER BY o.full_name_en`;
  return rows.map((r) => ({
    id: String(r['id']), nameEn: String(r['full_name_en']), nameAr: String(r['full_name_ar']),
    phone: r['phone'] === null ? null : String(r['phone']),
    email: r['email'] === null ? null : String(r['email']),
    shareBps: Number(r['share_bps']), properties: Number(r['properties']),
  }));
}

// ------------------------------------------------------- documents / settings

export interface DocumentRow {
  id: string; entityType: string; title: string; status: string; version: number;
  isLatest: boolean; mime: string | null; bytes: number | null; createdAt: string;
}

export async function documentsForOrg(orgId: string): Promise<DocumentRow[]> {
  const rows = await sql`
    SELECT id, entity_type, title, status, version, is_latest, mime, bytes, created_at
    FROM documents WHERE organization_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
  return rows.map((r) => ({
    id: String(r['id']), entityType: String(r['entity_type']), title: String(r['title']),
    status: String(r['status']), version: Number(r['version']), isLatest: Boolean(r['is_latest']),
    mime: r['mime'] === null ? null : String(r['mime']),
    bytes: r['bytes'] === null ? null : Number(r['bytes']),
    createdAt: String(r['created_at']).slice(0, 10),
  }));
}

export interface OrgUserRow {
  id: string; email: string; role: string; nameEn: string; nameAr: string; isActive: boolean;
}

export async function usersForOrg(orgId: string): Promise<OrgUserRow[]> {
  const rows = await sql`
    SELECT id, email, role, name_en, name_ar, is_active
    FROM users WHERE organization_id = ${orgId} ORDER BY role, email`;
  return rows.map((r) => ({
    id: String(r['id']), email: String(r['email']), role: String(r['role']),
    nameEn: String(r['name_en']), nameAr: String(r['name_ar']), isActive: Boolean(r['is_active']),
  }));
}
