import type { IsoDate } from '@aqar/contracts';

/**
 * Shared pure helpers for the terms engine: exact integer money math,
 * proleptic Gregorian date arithmetic (no `Date` object, no timezone, no wall
 * clock), Arabic-aware text normalization and FNV-1a hashing.
 */

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer (received ${String(value)})`);
  }
  return value;
}

export function assertNonNegativeInteger(value: number, label: string): number {
  assertSafeInteger(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must be >= 0 (received ${String(value)})`);
  }
  return value;
}

export function assertPositiveInteger(value: number, label: string): number {
  assertSafeInteger(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} must be > 0 (received ${String(value)})`);
  }
  return value;
}

/**
 * `floor(a * b / c)` computed with BigInt so money never depends on float
 * multiplication. Inputs must be safe integers and `c` must be positive.
 */
export function mulDivFloor(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c)) {
    throw new RangeError('mulDivFloor expects safe integer inputs');
  }
  if (c <= 0) {
    throw new RangeError('mulDivFloor expects a positive divisor');
  }
  const result = Number((BigInt(a) * BigInt(b)) / BigInt(c));
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('mulDivFloor result exceeds the safe integer range');
  }
  return result;
}

/** `(a * b) % m`, exact, via BigInt so large weights cannot overflow. */
export function mulMod(a: number, b: number, m: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(m)) {
    throw new RangeError('mulMod expects safe integer inputs');
  }
  if (m <= 0) {
    throw new RangeError('mulMod expects a positive modulus');
  }
  return Number((BigInt(a) * BigInt(b)) % BigInt(m));
}

/**
 * Largest-remainder apportionment of `totalFils` across integer weights.
 *
 * `output[i] = floor(totalFils * weights[i] / sumWeights)`, then the remaining
 * fils are handed out one at a time, largest fractional remainder first, until
 * the total is exhausted. Ties are broken by `tieKeys` ascending (a plain code
 * unit comparison, never locale-sensitive) and finally by input order. The
 * output therefore ALWAYS sums exactly to `totalFils`.
 */
export function apportionLargestRemainder(
  totalFils: number,
  weights: readonly number[],
  tieKeys: readonly string[],
): number[] {
  assertNonNegativeInteger(totalFils, 'totalFils');
  if (weights.length === 0) {
    throw new RangeError('weights must not be empty');
  }
  if (tieKeys.length !== weights.length) {
    throw new RangeError('tieKeys must have the same length as weights');
  }
  let weightSum = 0;
  for (const weight of weights) {
    assertNonNegativeInteger(weight, 'weight');
    weightSum += weight;
  }
  if (weightSum === 0) {
    throw new RangeError('weights must not all be zero');
  }

  const bases: number[] = [];
  const remainders: number[] = [];
  let distributed = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? 0;
    const base = mulDivFloor(totalFils, weight, weightSum);
    bases.push(base);
    remainders.push(mulMod(totalFils % weightSum, weight, weightSum));
    distributed += base;
  }

  let leftover = totalFils - distributed;
  const order = bases.map((_base, index) => index);
  order.sort((a, b) => {
    const remainderA = remainders[a] ?? 0;
    const remainderB = remainders[b] ?? 0;
    if (remainderA !== remainderB) {
      return remainderB - remainderA;
    }
    const keyA = tieKeys[a] ?? '';
    const keyB = tieKeys[b] ?? '';
    if (keyA !== keyB) {
      return keyA < keyB ? -1 : 1;
    }
    return a - b;
  });

  for (const index of order) {
    if (leftover <= 0) {
      break;
    }
    bases[index] = (bases[index] ?? 0) + 1;
    leftover -= 1;
  }
  if (leftover !== 0) {
    throw new RangeError('apportionment left unassigned fils');
  }
  return bases;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthPrime = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(epochDay: number): { year: number; month: number; day: number } {
  const shifted = epochDay + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
  return { year: month <= 2 ? year + 1 : year, month, day };
}

/** Validates `YYYY-MM-DD` including real calendar days (2026-02-30 is rejected). */
export function parseIsoDate(value: string, label: string): IsoDate {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    throw new RangeError(`${label} must be an ISO date YYYY-MM-DD (received ${value})`);
  }
  const year = Number(match[1] ?? '');
  const month = Number(match[2] ?? '');
  const day = Number(match[3] ?? '');
  const roundTrip = civilFromDays(daysFromCivil(year, month, day));
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day) {
    throw new RangeError(`${label} is not a real calendar date: ${value}`);
  }
  return value as IsoDate;
}

export function toEpochDay(iso: IsoDate): number {
  const match = ISO_DATE_PATTERN.exec(iso);
  if (match === null) {
    throw new RangeError(`invalid ISO date: ${iso}`);
  }
  return daysFromCivil(Number(match[1] ?? ''), Number(match[2] ?? ''), Number(match[3] ?? ''));
}

export function formatIsoDate(parts: { year: number; month: number; day: number }): IsoDate {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** UTC-safe calendar-day arithmetic: no `Date`, no DST, no timezone. */
export function addDaysISO(iso: IsoDate, days: number): IsoDate {
  assertSafeInteger(days, 'days');
  return formatIsoDate(civilFromDays(toEpochDay(iso) + days));
}

function isArabicDiacritic(codePoint: number): boolean {
  return (
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed)
  );
}

/**
 * Normalization shared by name matching and bank-line fingerprints:
 * lowercase, Arabic-Indic digits to ASCII, Arabic diacritics and tatweel
 * stripped, alef variants folded to plain alef, whitespace collapsed.
 */
export function normalizeArabicText(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  let out = '';
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint >= 0x0660 && codePoint <= 0x0669) {
      out += String.fromCharCode(0x30 + (codePoint - 0x0660));
      continue;
    }
    if (codePoint >= 0x06f0 && codePoint <= 0x06f9) {
      out += String.fromCharCode(0x30 + (codePoint - 0x06f0));
      continue;
    }
    if (codePoint === 0x0640 || isArabicDiacritic(codePoint)) {
      continue;
    }
    if (
      codePoint === 0x0622 ||
      codePoint === 0x0623 ||
      codePoint === 0x0625 ||
      codePoint === 0x0671
    ) {
      out += '\u0627';
      continue;
    }
    out += character;
  }
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

function utf8Bytes(codePoint: number): number[] {
  if (codePoint < 0x80) {
    return [codePoint];
  }
  if (codePoint < 0x800) {
    return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  }
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ];
}

/** Deterministic FNV-1a 32-bit hash rendered as 8 lowercase hex characters. */
export function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    for (const byte of utf8Bytes(codePoint)) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}
