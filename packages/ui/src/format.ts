import type { Locale } from '@aqar/contracts';

/** Money always renders with 3 decimals: '1,250.000 د.أ' (ar) / 'JOD 1,250.000' (en). */
export function formatMoney(fils: number, locale: Locale): string {
  const jod = fils / 1000; // display-only division; ledger math stays integer in core
  const num = new Intl.NumberFormat(locale === 'ar' ? 'ar-JO' : 'en-JO', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(jod);
  return locale === 'ar' ? `${num} د.أ` : `JOD ${num}`;
}

export function formatDate(iso: string, locale: Locale): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-JO' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(d);
}

export function formatPercentBps(bps: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-JO' : 'en-JO', {
    style: 'percent', maximumFractionDigits: 1,
  }).format(bps / 10000);
}

/** clsx-style class joiner, pure. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}
