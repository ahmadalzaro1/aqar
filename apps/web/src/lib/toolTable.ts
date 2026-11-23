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
