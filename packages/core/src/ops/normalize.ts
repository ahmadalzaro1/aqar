// Pure text normalization for the deterministic hazard pre-check.
// LAW 1: string ops only — no I/O, no clock, no randomness.
//
// Why normalization exists: tenants write in Arabic (MSA + Levantine), English,
// or a mix, with diacritics, tatweel, and Arabic-Indic digits. The hazard
// catalogue is authored once in natural spelling, then normalized with the same
// function as the ticket text so both sides are compared in one canonical form.

const ARABIC_DIACRITICS = /[\u064B-\u0652\u0670]/g;
const TATWEEL = /\u0640/g;
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/g;
const EXTENDED_ARABIC_INDIC_DIGITS = /[\u06F0-\u06F9]/g;

function toAsciiDigit(digit: string, base: number): string {
  return String(digit.charCodeAt(0) - base);
}

/**
 * Canonical form used by every hazard comparison.
 *
 * 1. lowercase (Latin)
 * 2. drop zero-width / bidi control characters
 * 3. strip Arabic diacritics (U+064B..U+0652, U+0670) and tatweel (U+0640)
 * 4. unify alef variants (أ إ آ) to bare alef, hamza carriers (ئ ؤ) to yeh/waw
 * 5. unify ta-marbuta (ة) to heh and alef-maqsura (ى) to yeh
 * 6. Arabic-Indic digits to ASCII
 * 7. collapse all whitespace runs to a single space and trim
 */
export function normalizeText(input: string): string {
  const lowered = input.toLowerCase();
  const cleaned = lowered
    .replace(ZERO_WIDTH, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0626/g, '\u064A')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064A');

  return cleaned
    .replace(ARABIC_INDIC_DIGITS, (d) => toAsciiDigit(d, 0x0660))
    .replace(EXTENDED_ARABIC_INDIC_DIGITS, (d) => toAsciiDigit(d, 0x06f0))
    .replace(/\s+/g, ' ')
    .trim();
}
