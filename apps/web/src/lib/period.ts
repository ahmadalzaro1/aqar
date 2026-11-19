import type { Period } from '@aqar/contracts';

export function currentPeriod(): Period {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function shiftPeriod(period: Period, delta: number): Period {
  const parts = period.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function isPeriod(v: string | undefined): v is Period {
  return v !== undefined && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}
