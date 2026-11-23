// Read-only data access for the console. Every query is scoped by organization_id.
// Column names reconciled against packages/db/src/schema (the source of truth).
import { sql } from './db';
import type { UnitStatus } from '@aqar/core';

export interface UnitRow {
  id: string;
  status: UnitStatus;
  propertyId: string;
}
export interface ChargeRow {
  id: string;
  leaseId: string;
  period: string;
  kind: string;
  amountFils: number;
  dueDate: string;
  paidFils: number;
  tenantName: string;
  unitLabel: string;
  propertyName: string;
}
export interface TicketRow {
  id: string;
  status: string;
  emergencyFlag: boolean;
  openedAt: string;
  channel: string;
  text: string;
  category: string | null;
  severity: string | null;
  confidence: number | null;
  unitLabel: string | null;
  propertyName: string;
}

const UNIT_STATUSES: readonly string[] = ['occupied', 'vacant', 'turnover', 'unavailable'];
function asUnitStatus(value: unknown): UnitStatus {
  const s = String(value);
  return UNIT_STATUSES.includes(s) ? (s as UnitStatus) : 'unavailable';
}

export async function unitsByStatus(orgId: string): Promise<UnitRow[]> {
  const rows = await sql`
    SELECT id, status, property_id FROM units WHERE organization_id = ${orgId}`;
  return rows.map((r) => ({
    id: String(r['id']),
    status: asUnitStatus(r['status']),
    propertyId: String(r['property_id']),
  }));
}

/**
 * Everything the estate atlas draws, in one pass: the site (property), the
 * building that holds the flats, each flat's status and rent, the active
 * tenant, and what that flat owes past due. Grouping happens in TypeScript so
 * the database is read once per render.
 */
export interface AtlasUnit {
  id: string;
  unitNumber: string;
  floor: string | null;
  spaceKind: string;
  status: UnitStatus;
  bedrooms: number | null;
  bathrooms: number | null;
  areaSqm: number | null;
  marketRentFils: number;
  tenantName: string | null;
  leaseEnd: string | null;
  balanceFils: number;
}

export interface AtlasSite {
  id: string;
  name: string;
  nameAr: string;
  district: string;
  city: string;
  assetKind: string;
  landAreaSqm: number | null;
  /** Real coordinates from the deed record, so a site can be drawn on a map. */
  lat: number | null;
  lng: number | null;
  buildingName: string | null;
  floors: number | null;
  units: AtlasUnit[];
}

export async function atlasSites(orgId: string): Promise<AtlasSite[]> {
  const rows = await sql`
    SELECT
      u.id, u.unit_number, u.floor, u.space_kind::text AS space_kind, u.status::text AS status,
      u.bedrooms, u.bathrooms, u.area_sqm, COALESCE(u.market_rent_fils, 0)::int AS market_rent_fils,
      p.id AS property_id, p.name, p.name_ar, p.district, p.city,
      p.asset_kind::text AS asset_kind, p.land_area_sqm, p.lat, p.lng,
      -- Only one alias may be called building_name: the building row is the one
      -- that carries a name the app displays (properties.building_name is the
      -- deed label and is allowed to be empty).
      b.name AS building_name, b.floors,
      tn.tenant_name, tn.lease_end,
      COALESCE(bal.balance_fils, 0)::int AS balance_fils
    FROM units u
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN buildings b ON b.id = u.building_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(t.full_name_ar, ''), t.full_name_en) AS tenant_name,
             to_char(l.end_date, 'YYYY-MM-DD') AS lease_end
      FROM leases l
      JOIN lease_tenants lt ON lt.lease_id = l.id
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE l.unit_id = u.id AND l.status = 'active'
      ORDER BY lt.is_primary DESC, l.end_date DESC
      LIMIT 1
    ) tn ON true
    -- Arrears for a flat = its charges past due, net of what has been allocated
    -- to them. A per-charge subquery keeps the sum from fanning out.
    LEFT JOIN LATERAL (
      SELECT SUM(
               c.amount_fils - COALESCE((
                 SELECT SUM(pa.amount_fils) FROM payment_allocations pa WHERE pa.charge_id = c.id
               ), 0)
             ) AS balance_fils
      FROM charges c
      JOIN leases l2 ON l2.id = c.lease_id
      WHERE l2.unit_id = u.id AND c.due_date < CURRENT_DATE
    ) bal ON true
    WHERE u.organization_id = ${orgId}
    ORDER BY p.name, b.name, u.floor NULLS FIRST, u.unit_number`;

  const sites = new Map<string, AtlasSite>();
  for (const r of rows) {
    const propertyId = String(r['property_id']);
    let site = sites.get(propertyId);
    if (site === undefined) {
      site = {
        id: propertyId,
        name: String(r['name']),
        nameAr: String(r['name_ar']),
        district: String(r['district']),
        city: String(r['city']),
        assetKind: String(r['asset_kind']),
        landAreaSqm: r['land_area_sqm'] === null ? null : Number(r['land_area_sqm']),
        lat: r['lat'] === null ? null : Number(r['lat']),
        lng: r['lng'] === null ? null : Number(r['lng']),
        buildingName: r['building_name'] === null ? null : String(r['building_name']),
        floors: r['floors'] === null ? null : Number(r['floors']),
        units: [],
      };
      sites.set(propertyId, site);
    }
    site.units.push({
      id: String(r['id']),
      unitNumber: String(r['unit_number']),
      floor: r['floor'] === null ? null : String(r['floor']),
      spaceKind: String(r['space_kind']),
      status: asUnitStatus(r['status']),
      bedrooms: r['bedrooms'] === null ? null : Number(r['bedrooms']),
      bathrooms: r['bathrooms'] === null ? null : Number(r['bathrooms']),
      areaSqm: r['area_sqm'] === null ? null : Number(r['area_sqm']),
      marketRentFils: Number(r['market_rent_fils']),
      tenantName: r['tenant_name'] === null ? null : String(r['tenant_name']),
      leaseEnd: r['lease_end'] === null ? null : String(r['lease_end']).slice(0, 10),
      balanceFils: Number(r['balance_fils']),
    });
  }
  return [...sites.values()];
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
    id: String(r['id']),
    leaseId: String(r['lease_id']),
    period: String(r['period']),
    kind: String(r['kind']),
    amountFils: Number(r['amount_fils']),
    dueDate: (r['due_date'] instanceof Date
      ? r['due_date'].toISOString()
      : String(r['due_date'])
    ).slice(0, 10),
    paidFils: Number(r['paid_fils']),
    tenantName: String(r['tenant_name']),
    unitLabel: String(r['unit_label']),
    propertyName: String(r['property_name']),
  }));
}

// Scalar subqueries: a JOIN to allocations would fan out charge rows and inflate SUM(amount).
export async function collectionTotals(
  orgId: string,
  period: string,
): Promise<{ billed: number; collected: number }> {
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
    id: String(r['id']),
    status: String(r['status']),
    emergencyFlag: Boolean(r['emergency_flag']),
    openedAt: new Date(String(r['opened_at'])).toISOString(),
    channel: String(r['channel']),
    text: String(r['text']),
    category: r['category'] === null ? null : String(r['category']),
    severity: r['severity'] === null ? null : String(r['severity']),
    confidence: r['confidence'] === null ? null : Number(r['confidence']),
    unitLabel: r['unit_label'] === null ? null : String(r['unit_label']),
    propertyName: String(r['property_name']),
  }));
}

export async function ticketMessages(
  ticketId: string,
): Promise<{ body: string; sender: string; at: string }[]> {
  const rows = await sql`
    SELECT body, direction AS sender, sent_at AS at FROM ticket_messages
    WHERE ticket_id = ${ticketId} ORDER BY sent_at`;
  return rows.map((r) => ({
    body: String(r['body']),
    sender: String(r['sender']),
    at: String(r['at']),
  }));
}

export async function orgName(orgId: string): Promise<string> {
  const rows = await sql`SELECT name FROM organizations WHERE id = ${orgId}`;
  return rows[0] === undefined ? 'Aqar' : String(rows[0]['name']);
}

// ---------------------------------------------------------------- portfolio

export interface PropertyRow {
  id: string;
  name: string;
  nameAr: string;
  district: string | null;
  city: string | null;
  units: number;
  occupied: number;
  vacant: number;
  buildings: number;
  marketRentFils: number;
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
    id: String(r['id']),
    name: String(r['name']),
    nameAr: String(r['name_ar']),
    district: r['district'] === null ? null : String(r['district']),
    city: r['city'] === null ? null : String(r['city']),
    units: Number(r['units']),
    occupied: Number(r['occupied']),
    vacant: Number(r['vacant']),
    buildings: Number(r['buildings']),
    marketRentFils: Number(r['market_rent']),
  }));
}

export interface VacantUnitRow {
  id: string;
  unitNumber: string;
  floor: number | null;
  bedrooms: number | null;
  areaSqm: number | null;
  marketRentFils: number;
  propertyName: string;
  status: string;
}

export async function unitsNeedingTenant(orgId: string): Promise<VacantUnitRow[]> {
  const rows = await sql`
    SELECT u.id, u.unit_number, u.floor, u.bedrooms, u.area_sqm, u.market_rent_fils,
           u.status, p.name AS property_name
    FROM units u JOIN properties p ON p.id = u.property_id
    WHERE u.organization_id = ${orgId} AND u.status IN ('vacant', 'turnover')
    ORDER BY p.name, u.unit_number`;
  return rows.map((r) => ({
    id: String(r['id']),
    unitNumber: String(r['unit_number']),
    floor: r['floor'] === null ? null : Number(r['floor']),
    bedrooms: r['bedrooms'] === null ? null : Number(r['bedrooms']),
    areaSqm: r['area_sqm'] === null ? null : Number(r['area_sqm']),
    marketRentFils: Number(r['market_rent_fils']),
    propertyName: String(r['property_name']),
    status: String(r['status']),
  }));
}

export interface LeaseRow {
  id: string;
  status: string;
  startDate: string;
  endDate: string;
  rentFils: number;
  depositFils: number;
  dueDay: number;
  unitNumber: string;
  propertyName: string;
  tenantEn: string;
  tenantAr: string;
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
    id: String(r['id']),
    status: String(r['status']),
    startDate: String(r['start_date']).slice(0, 10),
    endDate: String(r['end_date']).slice(0, 10),
    rentFils: Number(r['rent_fils']),
    depositFils: Number(r['deposit_fils']),
    dueDay: Number(r['due_day']),
    unitNumber: String(r['unit_number']),
    propertyName: String(r['property_name']),
    tenantEn: String(r['tenant_en']),
    tenantAr: String(r['tenant_ar']),
  }));
}

// ------------------------------------------------------------ vendors/owners

export interface VendorRow {
  id: string;
  nameEn: string;
  nameAr: string;
  phone: string | null;
  email: string | null;
  trades: string[];
  coverage: string[];
  rating: number | null;
  allowListed: boolean;
  insuranceExpiry: string | null;
}

export async function vendorsForOrg(orgId: string): Promise<VendorRow[]> {
  const rows = await sql`
    SELECT id, name_en, name_ar, phone, email, trades, coverage_areas, rating,
           allow_listed, insurance_cert_expiry
    FROM vendors WHERE organization_id = ${orgId} ORDER BY name_en`;
  return rows.map((r) => ({
    id: String(r['id']),
    nameEn: String(r['name_en']),
    nameAr: String(r['name_ar']),
    phone: r['phone'] === null ? null : String(r['phone']),
    email: r['email'] === null ? null : String(r['email']),
    trades: Array.isArray(r['trades']) ? (r['trades'] as string[]) : [],
    coverage: Array.isArray(r['coverage_areas']) ? (r['coverage_areas'] as string[]) : [],
    rating: r['rating'] === null ? null : Number(r['rating']),
    allowListed: Boolean(r['allow_listed']),
    insuranceExpiry:
      r['insurance_cert_expiry'] === null ? null : String(r['insurance_cert_expiry']).slice(0, 10),
  }));
}

export interface OwnerRow {
  id: string;
  nameEn: string;
  nameAr: string;
  phone: string | null;
  email: string | null;
  shareBps: number;
  properties: number;
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
    id: String(r['id']),
    nameEn: String(r['full_name_en']),
    nameAr: String(r['full_name_ar']),
    phone: r['phone'] === null ? null : String(r['phone']),
    email: r['email'] === null ? null : String(r['email']),
    shareBps: Number(r['share_bps']),
    properties: Number(r['properties']),
  }));
}

// ------------------------------------------------------- documents / settings

export interface DocumentRow {
  id: string;
  entityType: string;
  title: string;
  status: string;
  version: number;
  isLatest: boolean;
  mime: string | null;
  bytes: number | null;
  createdAt: string;
}

export async function documentsForOrg(orgId: string): Promise<DocumentRow[]> {
  const rows = await sql`
    SELECT id, entity_type, title, status, version, is_latest, mime, bytes, created_at
    FROM documents WHERE organization_id = ${orgId} ORDER BY created_at DESC LIMIT 50`;
  return rows.map((r) => ({
    id: String(r['id']),
    entityType: String(r['entity_type']),
    title: String(r['title']),
    status: String(r['status']),
    version: Number(r['version']),
    isLatest: Boolean(r['is_latest']),
    mime: r['mime'] === null ? null : String(r['mime']),
    bytes: r['bytes'] === null ? null : Number(r['bytes']),
    createdAt: String(r['created_at']).slice(0, 10),
  }));
}

export interface OrgUserRow {
  id: string;
  email: string;
  role: string;
  nameEn: string;
  nameAr: string;
  isActive: boolean;
}

export async function usersForOrg(orgId: string): Promise<OrgUserRow[]> {
  const rows = await sql`
    SELECT id, email, role, name_en, name_ar, is_active
    FROM users WHERE organization_id = ${orgId} ORDER BY role, email`;
  return rows.map((r) => ({
    id: String(r['id']),
    email: String(r['email']),
    role: String(r['role']),
    nameEn: String(r['name_en']),
    nameAr: String(r['name_ar']),
    isActive: Boolean(r['is_active']),
  }));
}
