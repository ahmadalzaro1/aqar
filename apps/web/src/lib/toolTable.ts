/**
 * Deterministic table rendering for list-shaped tool results.
 *
 * Why this exists: a small local model asked to "reformat 25 arrears rows" will
 * do three things badly — re-convert money, drop the header, and run out of
 * tokens mid-row. The rows are already structured; re-typing them through a
 * language model adds risk and subtracts nothing. So the server renders the
 * table from the tool's own fields, and the model writes only the lead sentence.
 *
 * Money: cells carry the tool's `*Jod` string verbatim (e.g. "885.000"). The
 * currency label belongs to the column header, never to the cell — that is what
 * stopped "885,000 FILS / 885.000 JOD" from being printed side by side.
 */

/**
 * Every column header the chat can render. `TableColumn.labelKey` is typed as this
 * union and ChatDock's label maps are `satisfies Record<ChatColumnKey, string>`, so
 * adding a column without a header in BOTH locales is a typecheck failure rather
 * than a raw `chat.col.x` leaking into the UI.
 */
export const CHAT_COLUMN_KEYS = [
  'chat.col.tenant',
  'chat.col.unit',
  'chat.col.property',
  'chat.col.outstanding',
  'chat.col.since',
  'chat.col.floor',
  'chat.col.area',
  'chat.col.total',
  'chat.col.units',
  'chat.col.occupied',
  'chat.col.occupancy',
  'chat.col.tickets',
  'chat.col.endDate',
  'chat.col.daysLeft',
  'chat.col.rent',
  'chat.col.period',
  'chat.col.charged',
  'chat.col.collected',
  'chat.col.rate',
  'chat.col.status',
  'chat.col.deposit',
  'chat.col.leaseEnd',
  'chat.col.arrears',
  'chat.col.gross',
  'chat.col.expenses',
  'chat.col.fee',
  'chat.col.net',
] as const;

export type ChatColumnKey = (typeof CHAT_COLUMN_KEYS)[number];

/**
 * Enum values that reach the operator must be words, not codes. The database stores
 * `active`; an Arabic console must not show it. Unknown values pass through unchanged
 * so a new enum member is visible rather than silently blanked.
 */
const STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  active: { ar: 'ساري', en: 'Active' },
  draft: { ar: 'مسودة', en: 'Draft' },
  expired: { ar: 'منتهٍ', en: 'Expired' },
  terminated: { ar: 'مفسوخ', en: 'Terminated' },
  vacant: { ar: 'فاضية', en: 'Vacant' },
  occupied: { ar: 'مشغولة', en: 'Occupied' },
  pending: { ar: 'قيد الانتظار', en: 'Pending' },
  notice: { ar: 'إشعار إخلاء', en: 'Notice given' },
  scheduled: { ar: 'مجدول', en: 'Scheduled' },
};

/**
 * Property names are stored in both languages. The console shows the one the
 * operator is reading in, falling back to the other rather than blanking a row.
 */
function propertyCell(row: Record<string, unknown>, locale: 'ar' | 'en'): string {
  const ar = typeof row['propertyAr'] === 'string' ? row['propertyAr'] : null;
  const en = typeof row['property'] === 'string' ? row['property'] : null;
  return (locale === 'ar' ? (ar ?? en) : (en ?? ar)) ?? '—';
}

export function statusLabel(value: unknown, locale: 'ar' | 'en'): string {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const hit = STATUS_LABELS[value.toLowerCase()];
  return hit === undefined ? value : hit[locale];
}

/**
 * One tool call as the console reports it. `error` is present only when a routed
 * call failed — the response then still names the tool, so a wrong route is
 * visible in the trace instead of disappearing into a generic apology.
 */
export interface ToolTrace {
  name: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface TableColumn {
  /** Field on the tool's row object. */
  key: string;
  /** i18n key for the header. */
  labelKey: ChatColumnKey;
  align?: 'start' | 'end';
  /** Locale-aware override, for rows that carry both Arabic and Latin names. */
  get?: (row: Record<string, unknown>, locale: 'ar' | 'en') => string;
}

export interface ToolTable {
  tool: string;
  columns: { key: string; labelKey: string; align: 'start' | 'end' }[];
  rows: Record<string, string>[];
  totalLabelKey?: string | undefined;
  total?: string | undefined;
  count: number;
}

interface TableSpec {
  arrayKey: string;
  columns: TableColumn[];
  totalKey?: string;
  countKey?: string;
}

const SPECS: Record<string, TableSpec> = {
  list_arrears: {
    arrayKey: 'tenants',
    columns: [
      {
        key: 'tenant',
        labelKey: 'chat.col.tenant',
        get: (row, locale) => {
          const ar = typeof row['nameAr'] === 'string' ? row['nameAr'] : null;
          const en = typeof row['nameEn'] === 'string' ? row['nameEn'] : null;
          return (locale === 'ar' ? (ar ?? en) : (en ?? ar)) ?? '—';
        },
      },
      { key: 'unitNumber', labelKey: 'chat.col.unit' },
      { key: 'property', labelKey: 'chat.col.property', get: propertyCell },
      { key: 'outstandingJod', labelKey: 'chat.col.outstanding', align: 'end' },
      { key: 'oldestUnpaidDue', labelKey: 'chat.col.since' },
    ],
    totalKey: 'totalOutstandingJod',
    countKey: 'count',
  },
  list_expiring_leases: {
    arrayKey: 'leases',
    columns: [
      { key: 'tenant', labelKey: 'chat.col.tenant' },
      { key: 'unitNumber', labelKey: 'chat.col.unit' },
      { key: 'property', labelKey: 'chat.col.property', get: propertyCell },
      { key: 'endDate', labelKey: 'chat.col.endDate' },
      { key: 'daysLeft', labelKey: 'chat.col.daysLeft', align: 'end' },
      { key: 'rentJod', labelKey: 'chat.col.rent', align: 'end' },
    ],
    countKey: 'count',
  },
  portfolio_summary: {
    arrayKey: 'properties',
    columns: [
      {
        key: 'property',
        labelKey: 'chat.col.property',
        get: (row, locale) => {
          const ar = typeof row['nameAr'] === 'string' ? row['nameAr'] : null;
          const en = typeof row['name'] === 'string' ? row['name'] : null;
          return (locale === 'ar' ? (ar ?? en) : (en ?? ar)) ?? '—';
        },
      },
      { key: 'units', labelKey: 'chat.col.units', align: 'end' },
      { key: 'occupied', labelKey: 'chat.col.occupied', align: 'end' },
      { key: 'occupancyPct', labelKey: 'chat.col.occupancy', align: 'end' },
      { key: 'openTickets', labelKey: 'chat.col.tickets', align: 'end' },
      { key: 'arrearsJod', labelKey: 'chat.col.outstanding', align: 'end' },
    ],
    totalKey: 'totals.arrearsJod',
  },
  list_vacant_units: {
    arrayKey: 'units',
    columns: [
      { key: 'unitNumber', labelKey: 'chat.col.unit' },
      { key: 'property', labelKey: 'chat.col.property', get: propertyCell },
      { key: 'floor', labelKey: 'chat.col.floor', align: 'end' },
      { key: 'areaSqm', labelKey: 'chat.col.area', align: 'end' },
    ],
    countKey: 'count',
  },
  tenant_account: {
    arrayKey: 'leases',
    columns: [
      { key: 'property', labelKey: 'chat.col.property', get: propertyCell },
      { key: 'unitNumber', labelKey: 'chat.col.unit' },
      {
        key: 'status',
        labelKey: 'chat.col.status',
        get: (row, locale) => statusLabel(row['status'], locale),
      },
      { key: 'rentJod', labelKey: 'chat.col.rent', align: 'end' },
      { key: 'outstandingJod', labelKey: 'chat.col.outstanding', align: 'end' },
      { key: 'oldestUnpaidDue', labelKey: 'chat.col.since' },
    ],
    totalKey: 'totalOutstandingJod',
    countKey: 'count',
  },
  deposits_held: {
    arrayKey: 'deposits',
    columns: [
      { key: 'tenant', labelKey: 'chat.col.tenant' },
      { key: 'unitNumber', labelKey: 'chat.col.unit' },
      { key: 'property', labelKey: 'chat.col.property', get: propertyCell },
      { key: 'depositJod', labelKey: 'chat.col.deposit', align: 'end' },
      { key: 'leaseEnd', labelKey: 'chat.col.leaseEnd' },
    ],
    totalKey: 'totalDepositJod',
    countKey: 'count',
  },
  collections: {
    arrayKey: 'periods',
    columns: [
      { key: 'period', labelKey: 'chat.col.period' },
      { key: 'chargedJod', labelKey: 'chat.col.charged', align: 'end' },
      { key: 'allocatedJod', labelKey: 'chat.col.collected', align: 'end' },
      { key: 'collectionRatePct', labelKey: 'chat.col.rate', align: 'end' },
    ],
    countKey: 'count',
  },
  rent_roll: {
    arrayKey: 'units',
    columns: [
      { key: 'unitNumber', labelKey: 'chat.col.unit' },
      { key: 'property', labelKey: 'chat.col.property', get: propertyCell },
      { key: 'tenant', labelKey: 'chat.col.tenant' },
      {
        key: 'unitStatus',
        labelKey: 'chat.col.status',
        get: (row, locale) => statusLabel(row['unitStatus'], locale),
      },
      { key: 'rentJod', labelKey: 'chat.col.rent', align: 'end' },
      { key: 'arrearsJod', labelKey: 'chat.col.arrears', align: 'end' },
      { key: 'endDate', labelKey: 'chat.col.endDate' },
    ],
    countKey: 'count',
  },
  owner_statement: {
    arrayKey: 'statements',
    columns: [
      { key: 'property', labelKey: 'chat.col.property', get: propertyCell },
      { key: 'period', labelKey: 'chat.col.period' },
      { key: 'grossJod', labelKey: 'chat.col.gross', align: 'end' },
      { key: 'expensesJod', labelKey: 'chat.col.expenses', align: 'end' },
      { key: 'managementFeeJod', labelKey: 'chat.col.fee', align: 'end' },
      { key: 'netJod', labelKey: 'chat.col.net', align: 'end' },
    ],
    totalKey: 'totalNetJod',
    countKey: 'count',
  },
};

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length === 0 ? '—' : value;
  if (typeof value === 'number') return String(value);
  return '—';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The lead sentence, built from the tool's own numbers.
 *
 * Why not let the model write it: with two properties in the payload it reported
 * "50% (18 of 24)" — a per-property figure glued to an organisation total, plus a
 * vacant count that existed nowhere. A property manager does 18/24 in their head and
 * stops trusting the console. Arithmetic belongs to the layer that holds the rows.
 */
export function leadForTool(
  tool: string,
  locale: 'ar' | 'en',
  result: unknown,
  table: ToolTable | null,
): string | null {
  const ar = locale === 'ar';
  const record =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};

  if (tool === 'portfolio_summary') {
    const totals =
      typeof record['totals'] === 'object' && record['totals'] !== null
        ? (record['totals'] as Record<string, unknown>)
        : {};
    const units = num(totals['units']);
    const occupied = num(totals['occupied']);
    if (units === null || occupied === null || units === 0) return null;
    const pct = Math.round((occupied / units) * 1000) / 10;
    const vacant = num(totals['vacant']);
    const arrears = typeof totals['arrearsJod'] === 'string' ? totals['arrearsJod'] : null;
    const properties = Array.isArray(record['properties']) ? record['properties'].length : 0;
    const tickets = (record['properties'] ?? []) as Record<string, unknown>[];
    const openTickets = tickets.reduce((sum, row) => sum + (num(row['openTickets']) ?? 0), 0);
    return ar
      ? `${pct}% إشغال (${occupied} من ${units} وحدة) على ${properties} عقار. ` +
          (vacant === null ? '' : `الفارغ ${vacant} وحدة. `) +
          (arrears === null ? '' : `المستحق على المستأجرين ${arrears} د.أ. `) +
          `تذاكر مفتوحة ${openTickets}. التفصيل لكل عقار أدناه.`
      : `${pct}% occupancy (${occupied} of ${units} units) across ${properties} properties. ` +
          (vacant === null ? '' : `${vacant} vacant. `) +
          (arrears === null ? '' : `${arrears} JOD outstanding. `) +
          `${openTickets} open tickets. Per-property breakdown below.`;
  }

  if (tool === 'list_expiring_leases') {
    const count = num(record['count']) ?? 0;
    const days = num(record['withinDays']);
    const window = days === null ? '' : ar ? ` خلال ${days} يومًا` : ` within ${days} days`;
    if (count === 0) {
      return ar
        ? `لا عقود تنتهي${window}. لا حاجة لإجراء تجديد الآن.`
        : `No leases end${window}. Nothing to renew right now.`;
    }
    return ar
      ? `${count} عقد ينتهي${window}، مرتّبة حسب تاريخ الانتهاء.`
      : `${count} lease(s) ending${window}, soonest first.`;
  }

  if (tool === 'tenant_account') {
    const tenant = (record['tenant'] ?? {}) as Record<string, unknown>;
    const name = ar
      ? String(tenant['nameAr'] ?? tenant['nameEn'] ?? '—')
      : String(tenant['nameEn'] ?? tenant['nameAr'] ?? '—');
    const leases = Array.isArray(record['leases'])
      ? (record['leases'] as Record<string, unknown>[])
      : [];
    const total =
      typeof record['totalOutstandingJod'] === 'string' ? record['totalOutstandingJod'] : null;
    if (total === null) return null;
    const dates = leases
      .map((lease) => lease['oldestUnpaidDue'])
      .filter((d): d is string => typeof d === 'string')
      .sort();
    const oldest = dates[0] ?? null;
    const daysLate =
      leases
        .map((lease) => num(lease['daysLate']))
        .filter((d): d is number => d !== null)
        .sort((a, b) => b - a)[0] ?? null;
    if (Number(total) === 0) {
      return ar
        ? `${name}: لا يوجد مبلغ مستحق. جميع الدفعات مخصصة لبنودها.`
        : `${name}: nothing outstanding. Every payment is allocated to its charge.`;
    }
    const when =
      oldest === null
        ? ''
        : daysLate !== null && daysLate > 0
          ? ar
            ? `، أقدم استحقاق ${oldest} (متأخر ${daysLate} يومًا)`
            : `, oldest unpaid due ${oldest} (${daysLate} days late)`
          : ar
            ? `، أقدم استحقاق ${oldest}`
            : `, oldest unpaid due ${oldest}`;
    return ar
      ? `${name}: مستحق ${total} د.أ${when}. تفصيل العقود والبنود أدناه.`
      : `${name}: ${total} JOD outstanding${when}. Leases and charges below.`;
  }

  if (tool === 'deposits_held') {
    const total = typeof record['totalDepositJod'] === 'string' ? record['totalDepositJod'] : null;
    const count = num(record['count']);
    if (total === null || count === null) return null;
    return ar
      ? `نحتجز ${count} تأمينًا بقيمة ${total} د.أ. التفصيل لكل مستأجر ووحدة أدناه.`
      : `Holding ${count} deposit(s) totalling ${total} JOD. Per-tenant breakdown below.`;
  }

  if (tool === 'collections') {
    const rate = num(record['collectionRatePct']);
    const charged =
      typeof record['totalChargedJod'] === 'string' ? record['totalChargedJod'] : null;
    const collected =
      typeof record['totalAllocatedJod'] === 'string' ? record['totalAllocatedJod'] : null;
    const periods = num(record['count']) ?? 0;
    if (rate === null || charged === null || collected === null) return null;
    // Arabic counts 3–10 with a plural noun and 11+ with a singular.
    const periodWord = periods >= 3 && periods <= 10 ? 'فترات' : 'فترة';
    return ar
      ? `نسبة التحصيل ${rate}% — حُصّل ${collected} د.أ من أصل ${charged} د.أ عبر ${periods} ${periodWord}.`
      : `Collection rate ${rate}% — ${collected} JOD collected of ${charged} JOD charged across ${periods} ${periods === 1 ? 'period' : 'periods'}.`;
  }

  if (tool === 'rent_roll') {
    const units = Array.isArray(record['units'])
      ? (record['units'] as Record<string, unknown>[])
      : [];
    const count = num(record['count']) ?? units.length;
    const leased = units.filter(
      (unit) => unit['tenant'] !== null && unit['tenant'] !== undefined,
    ).length;
    const vacant = units.length - leased;
    const arrearsFils = units.reduce((sum, unit) => sum + (num(unit['arrearsFils']) ?? 0), 0);
    const arrears = (arrearsFils / 1000).toFixed(3);
    return ar
      ? `${count} وحدة: ${leased} مؤجّرة و${vacant} فاضية. متأخرات ${arrears} د.أ. التفصيل وحدة بوحدة أدناه.`
      : `${count} units: ${leased} leased, ${vacant} vacant. ${arrears} JOD in arrears. Unit-by-unit below.`;
  }

  if (tool === 'owner_statement') {
    const net = typeof record['totalNetJod'] === 'string' ? record['totalNetJod'] : null;
    const gross = typeof record['totalGrossJod'] === 'string' ? record['totalGrossJod'] : null;
    const expenses =
      typeof record['totalExpensesJod'] === 'string' ? record['totalExpensesJod'] : null;
    const fee =
      typeof record['totalManagementFeeJod'] === 'string' ? record['totalManagementFeeJod'] : null;
    const count = num(record['count']) ?? 0;
    if (net === null || gross === null || expenses === null || fee === null) return null;
    return ar
      ? `صافي ${net} د.أ عبر ${count} كشف: إجمالي ${gross}، مصاريف ${expenses}، أتعاب إدارة ${fee}.`
      : `${net} JOD net across ${count} statement(s): gross ${gross}, expenses ${expenses}, management fee ${fee}.`;
  }

  if (table === null) return null;

  if (tool === 'list_vacant_units') {
    const names = [...new Set(table.rows.map((row) => row['property'] ?? ''))].filter(
      (n) => n !== '',
    );
    const where =
      names.length === 0 ? '' : ar ? ` في ${names.join('، ')}` : ` in ${names.join(', ')}`;
    return ar
      ? `${table.count} وحدة فاضية${where}. الجدول أدناه يعرض الوحدة والطابق والمساحة.`
      : `${table.count} vacant unit(s)${where}. The table lists unit, floor and area.`;
  }

  if (tool === 'list_arrears') {
    const top = table.rows[0];
    const lead =
      top !== undefined && top['tenant'] !== undefined
        ? ar
          ? `أعلى مستحق: ${top['tenant']} — ${top['outstandingJod'] ?? '—'} د.أ (وحدة ${top['unitNumber'] ?? '—'}). `
          : `Largest debt: ${top['tenant']} — ${top['outstandingJod'] ?? '—'} JOD (unit ${top['unitNumber'] ?? '—'}). `
        : '';
    if (table.total === undefined) return lead.length > 0 ? lead.trimEnd() : null;
    return ar
      ? `${lead}الإجمالي ${table.total} د.أ على ${table.count} سجلًا، مرتّبًا من الأعلى إلى الأدنى.`
      : `${lead}${table.total} JOD across ${table.count} records, highest first.`;
  }

  return null;
}

/**
 * Build a table for the UI from a tool result, or null when this tool has no
 * list shape we know how to render. Never invents a column: fields come from
 * the tool's own row objects.
 */
export function tableForTool(tool: string, result: unknown, locale: 'ar' | 'en'): ToolTable | null {
  const spec = SPECS[tool];
  if (spec === undefined || typeof result !== 'object' || result === null) return null;

  const record = result as Record<string, unknown>;
  const array = record[spec.arrayKey];
  if (!Array.isArray(array) || array.length === 0) return null;

  const rows = array
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const out: Record<string, string> = {};
      for (const column of spec.columns) {
        out[column.key] =
          column.get !== undefined ? column.get(item, locale) : cell(item[column.key]);
      }
      return out;
    });

  const total = spec.totalKey === undefined ? undefined : record[spec.totalKey];
  const count =
    spec.countKey === undefined ? rows.length : Number(record[spec.countKey] ?? rows.length);

  return {
    tool,
    columns: spec.columns.map((column) => ({
      key: column.key,
      labelKey: column.labelKey,
      align: column.align ?? 'start',
    })),
    rows,
    totalLabelKey: total === undefined ? undefined : 'chat.col.total',
    total: typeof total === 'string' ? total : undefined,
    count: Number.isFinite(count) ? count : rows.length,
  };
}
