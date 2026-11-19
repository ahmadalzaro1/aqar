// Money is ALWAYS integer fils (1 JOD = 1000 fils, JOD has 3 decimals).
// No floats, no parseFloat, no locale formatting anywhere in here.
import type { Fils } from '@aqar/contracts';

export const FILS_PER_JOD = 1000;

export function assertFils(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`money must be an integer number of fils, got: ${String(value)}`);
  }
  if (value < 0) throw new Error(`money must be nonnegative, got: ${value}`);
  if (!Number.isSafeInteger(value)) throw new Error(`money exceeds safe integer range: ${value}`);
  return value;
}

const DECIMAL_JOD_RE = /^(\d+)(?:\.(\d{1,3}))?$/;

/**
 * Parses a JOD decimal string ('1250.500', '1250.5', '1250') into integer fils
 * without parseFloat. Rejects signs, whitespace, separators, >3 decimals, garbage.
 */
export function toFils(decimalString: string): Fils {
  if (typeof decimalString !== 'string') {
    throw new Error(`invalid JOD amount: ${String(decimalString)}`);
  }
  const match = DECIMAL_JOD_RE.exec(decimalString);
  if (match === null) throw new Error(`invalid JOD amount: "${decimalString}"`);
  const wholeText = match[1] ?? '';
  const fractionText = match[2] ?? '';
  const whole = Number(wholeText);
  if (!Number.isSafeInteger(whole)) throw new Error(`JOD amount out of range: "${decimalString}"`);
  const filsText = (fractionText + '000').slice(0, 3);
  const fractionFils = Number(filsText);
  const total = whole * FILS_PER_JOD + fractionFils;
  return assertFils(total);
}

/** Renders integer fils as a plain '1234.567' string: 3 decimals, no separators. */
export function formatFils(fils: number): string {
  const value = assertFils(fils);
  const whole = Math.floor(value / FILS_PER_JOD);
  const remainder = value - whole * FILS_PER_JOD;
  return `${whole}.${String(remainder).padStart(3, '0')}`;
}

/**
 * floor(a * b / divisor) using BigInt intermediates so no money product ever
 * loses precision, then converted back after a safe-integer check.
 */
export function mulDivFloor(a: number, b: number, divisor: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(divisor)) {
    throw new Error(`mulDivFloor requires safe integers: ${a}, ${b}, ${divisor}`);
  }
  if (divisor <= 0) throw new Error(`mulDivFloor requires a positive divisor, got: ${divisor}`);
  const result = (BigInt(a) * BigInt(b)) / BigInt(divisor);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('mulDivFloor result exceeds safe integer range');
  }
  return Number(result);
}

/** Adds nonnegative fils, refusing to silently overflow past safe-integer range. */
export function sumFils(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertFils(value);
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error('fils sum exceeds safe integer range');
  }
  return total;
}
