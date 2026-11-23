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

export interface TableColumn {
  /** Field on the tool's row object. */
  key: string;
  /** i18n key for the header. */
  labelKey: string;
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
      {
        key: 'property',
        labelKey: 'chat.col.property',
        get: (row, locale) => {
          const ar = typeof row['propertyAr'] === 'string' ? row['propertyAr'] : null;
          const en = typeof row['property'] === 'string' ? row['property'] : null;
          return (locale === 'ar' ? (ar ?? en) : (en ?? ar)) ?? '—';
        },
      },
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
      { key: 'property', labelKey: 'chat.col.property' },
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
      { key: 'property', labelKey: 'chat.col.property' },
      { key: 'floor', labelKey: 'chat.col.floor', align: 'end' },
      { key: 'areaSqm', labelKey: 'chat.col.area', align: 'end' },
    ],
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
