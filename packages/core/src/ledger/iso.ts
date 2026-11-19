// Pure calendar math. No wall-clock reads: every date is an input string.
// Implemented with integer civil-date arithmetic (Howard Hinnant's algorithms)
// so we never depend on Date parsing quirks or timezone offsets.
import type { IsoDate, Period } from '@aqar/contracts';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid month: ${month}`);
  }
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

export function parseIsoDate(iso: IsoDate): CivilDate {
  const match = ISO_DATE_RE.exec(iso);
  if (match === null) throw new Error(`invalid ISO date: ${iso}`);
  const yearText = match[1] ?? '';
  const monthText = match[2] ?? '';
  const dayText = match[3] ?? '';
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`invalid ISO date: ${iso}`);
  }
  if (month < 1 || month > 12) throw new Error(`invalid ISO date (month): ${iso}`);
  if (day < 1 || day > daysInMonth(year, month)) throw new Error(`invalid ISO date (day): ${iso}`);
  return { year, month, day };
}

export function isIsoDate(value: string): value is IsoDate {
  return ISO_DATE_RE.test(value) && (() => {
    try {
      parseIsoDate(value as IsoDate);
      return true;
    } catch {
      return false;
    }
  })();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function formatIsoDate(date: CivilDate): IsoDate {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Days since the Unix epoch, computed purely from civil fields. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil. */
export function civilFromDays(dayNumber: number): CivilDate {
  if (!Number.isInteger(dayNumber) || !Number.isSafeInteger(dayNumber)) {
    throw new Error(`invalid day number: ${dayNumber}`);
  }
  const shifted = dayNumber + 719468;
  const era = Math.floor(shifted / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

/** Absolute day index of an ISO date. Deterministic, no Date object. */
export function toDayNumber(iso: IsoDate): number {
  const date = parseIsoDate(iso);
  return daysFromCivil(date.year, date.month, date.day);
}

export function fromDayNumber(dayNumber: number): IsoDate {
  return formatIsoDate(civilFromDays(dayNumber));
}

/** Signed difference in whole days: toISO minus fromISO. */
export function daysBetween(fromISO: IsoDate, toISO: IsoDate): number {
  return toDayNumber(toISO) - toDayNumber(fromISO);
}

export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

export function parsePeriod(period: Period): YearMonth {
  const match = PERIOD_RE.exec(period);
  if (match === null) throw new Error(`invalid period: ${period}`);
  return { year: Number(match[1] ?? ''), month: Number(match[2] ?? '') };
}

export function formatPeriod(year: number, month: number): Period {
  if (month < 1 || month > 12) throw new Error(`invalid month: ${month}`);
  return `${pad(year, 4)}-${pad(month, 2)}`;
}

/** First and last day numbers of a billing period's month. */
export function monthBounds(period: Period): { firstDay: number; lastDay: number; days: number } {
  const { year, month } = parsePeriod(period);
  const days = daysInMonth(year, month);
  const firstDay = daysFromCivil(year, month, 1);
  return { firstDay, lastDay: firstDay + days - 1, days };
}
