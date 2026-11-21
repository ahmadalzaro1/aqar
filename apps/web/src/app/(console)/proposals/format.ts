// Rendering helpers shared by the server page and the client queue.
// Money is integer fils everywhere; JOD has 3 decimals, so every amount goes
// through `formatFils` from @aqar/core — never a bare division.
import { formatFils } from '@aqar/core';
import type { Locale } from '@aqar/contracts';

export type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok' | 'info';

interface Label {
  readonly en: string;
  readonly ar: string;
}

/** Argument keys the approval handlers actually use (packages/core + lib/approvals). */
const KEY_LABELS: Record<string, Label> = {
  amountFils: { en: 'Amount', ar: 'المبلغ' },
  leaseId: { en: 'Lease', ar: 'عقد الإيجار' },
  ticketId: { en: 'Ticket', ar: 'الطلب' },
  vendorId: { en: 'Vendor', ar: 'المورّد' },
  propertyId: { en: 'Property', ar: 'العقار' },
  planId: { en: 'Plan', ar: 'المخطط' },
  level: { en: 'Level', ar: 'الطابق' },
  rooms: { en: 'Rooms', ar: 'الوحدات' },
  body: { en: 'Message', ar: 'نص الرسالة' },
  locale: { en: 'Language', ar: 'اللغة' },
  method: { en: 'Method', ar: 'طريقة الدفع' },
  reference: { en: 'Reference', ar: 'المرجع' },
  receivedDate: { en: 'Received', ar: 'تاريخ الاستلام' },
  note: { en: 'Note', ar: 'ملاحظة' },
  nonce: { en: 'Nonce', ar: 'معرّف فريد' },
  probe: { en: 'Probe', ar: 'فحص' },
  code: { en: 'Code', ar: 'الرمز' },
  label: { en: 'Label', ar: 'التسمية' },
  areaSqm: { en: 'Area (m²)', ar: 'المساحة (م²)' },
  areaSource: { en: 'Area source', ar: 'مصدر المساحة' },
  paymentId: { en: 'Payment', ar: 'الدفعة' },
  allocatedFils: { en: 'Allocated', ar: 'المخصص' },
  error: { en: 'Error', ar: 'الخطأ' },
};

export function argLabel(key: string, locale: Locale): string {
  const entry = KEY_LABELS[key];
  return entry === undefined ? key : entry[locale];
}

/** A JSON key carrying money — the handlers name every amount `*Fils`. */
function isFilsKey(key: string): boolean {
  return /(?:Fils|_fils)$/.test(key);
}

function jod(fils: number, locale: Locale): string {
  const amount = formatFils(fils);
  return locale === 'ar' ? `${amount} د.أ` : `JOD ${amount}`;
}

/** Compact one-line rendering of one argument or result value. */
export function valueText(key: string, value: unknown, locale: Locale): string {
  return render(key, value, locale, 0);
}

function render(key: string, value: unknown, locale: Locale, depth: number): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length === 0 ? '—' : value;
  if (typeof value === 'number') {
    if (isFilsKey(key) && Number.isInteger(value) && value >= 0) return jod(value, locale);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (typeof value === 'object') {
    // Args are shallow by contract; the cap only stops a pathological blob from
    // turning one row into a wall of text.
    if (depth >= 2) return '…';
    if (Array.isArray(value)) {
      return value.length === 0 ? '—' : value.map((item) => render(key, item, locale, depth + 1)).join(' · ');
    }
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0
      ? '—'
      : entries.map(([k, v]) => `${argLabel(k, locale)}: ${render(k, v, locale, depth + 1)}`).join(' · ');
  }
  return String(value);
}

/** One rendered argument, already localised — the only shape the client sees. */
export interface ArgRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** jsonb arrives as unknown; anything that is not a plain object has no args to show. */
export function argEntries(args: unknown, locale: Locale): ArgRow[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => ({
    key,
    label: argLabel(key, locale),
    value: valueText(key, value, locale),
  }));
}

const dateFormats: Record<Locale, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Amman',
  }),
  ar: new Intl.DateTimeFormat('ar-JO', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Amman',
  }),
};

export function stamp(date: Date | null, locale: Locale): string {
  return date === null ? '—' : dateFormats[locale].format(date);
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'executed': return 'ok';
    // Reversed is not a failure: the action ran and was then undone on the
    // record. Amber keeps it visibly different from both.
    case 'reversed': return 'warn';
    case 'failed': return 'danger';
    case 'approved': return 'accent';
    case 'expired': return 'warn';
    case 'pending': return 'info';
    default: return 'neutral';
  }
}
