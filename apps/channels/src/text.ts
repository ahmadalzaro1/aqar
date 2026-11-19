/** Arabic + Arabic Supplement/Extended + presentation forms. */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;

/**
 * Body locale for storage/triage. Script detection, not a language model:
 * any Arabic-script codepoint means the message body is Arabic. Callers pass
 * the already-trimmed body.
 */
export function detectLocale(text: string): 'ar' | 'en' {
  return ARABIC_SCRIPT.test(text) ? 'ar' : 'en';
}

/** Collapses all whitespace runs (including newlines) to single spaces. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Ticket subject = first `max` user-perceived characters of the message,
 * whitespace-collapsed. Uses code points so Arabic text and emoji are never
 * split mid-surrogate-pair.
 */
export function toSubject(body: string, max = 60): string {
  const collapsed = collapseWhitespace(body);
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= max) return collapsed;
  return `${codePoints.slice(0, max).join('').trimEnd()}…`;
}
