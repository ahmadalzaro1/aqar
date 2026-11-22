import type { Trade } from './trades.js';

/**
 * One table decides what a trade is.
 *
 * Three vocabularies had grown up around the same question — "who can do this
 * job?" — and none of them agreed:
 *
 *   * `TicketCategory` (15): what the tenant reported (`plumbing`).
 *   * `Trade` (21): who fixes it (`plumber`).
 *   * `VendorTrade` (13, retired): how the roster was typed (`plumbing` again,
 *     plus `carpentry` and `painting`, which are not trades anyone dispatches
 *     by name).
 *
 * The console papered over the gap by deriving aliases from the taxonomy, and
 * the agent path matched with `ilike`, so the same question returned different
 * rosters depending on who asked. This module is the single door: a raw string
 * goes in, a `Trade` or `null` comes out, and every reader uses it.
 *
 * It also absorbs the words a human actually types — suppliers write "MEP" and
 * "Plumbing Works", the seed data we inherited wrote category names, and a
 * Jordanian roster writes «سباكة» and «مصاعد». Folding those into tokens here
 * means the database never has to know about them.
 */

/** Must stay in step with the `Trade` union in `trades.ts`. Asserted by test. */
export const TRADE_TOKENS: readonly Trade[] = [
  'gas_safety',
  'fire_safety',
  'electrician',
  'plumber',
  'drainage',
  'water_tank',
  'hvac',
  'structural_engineer',
  'locksmith',
  'elevator',
  'appliance_repair',
  'pest_control',
  'cleaning',
  'generator',
  'handyman',
  // capabilities that only exist as assets, never as a ticket category:
  'roofer_waterproofing',
  'security_systems',
  'kitchen_carpentry',
  'gate_automation',
  'signage_install',
  'solar_pv',
];

/**
 * Fold the ways Arabic and English are hand-typed into one comparable key:
 * case, tatweel, harakat, alef variants (`أإآٱ` → `ا`), `ى` → `ي`, `ة` → `ه`,
 * and runs of whitespace/punctuation → a single space.
 *
 * Folding here — not at the call site — is what stops a roster entry of
 * «سبّاكة» from being a different trade from «سباكة».
 */
export function foldTradeWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\u0640/g, '') // tatweel
    .replace(/[\u064B-\u0652\u0670]/g, '') // harakat
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // alef variants -> alef
    .replace(/\u0649/g, '\u064A') // alef maksura -> ya
    .replace(/\u0629/g, '\u0647') // ta marbuta -> ha
    .replace(/[\s_\-/\\]+/g, ' ')
    .trim();
}

/**
 * Words that mean a trade without being its token. Kept as a list of pairs and
 * folded at module load, so the keys on the left can be written the way a human
 * writes them.
 */
const ALIAS_PAIRS: readonly (readonly [string, Trade])[] = [
  // --- the retired VendorTrade vocabulary (category names used as trades) ---
  ['plumbing', 'plumber'],
  ['electrical', 'electrician'],
  ['gas', 'gas_safety'],
  ['appliance', 'appliance_repair'],
  ['pest', 'pest_control'],
  ['structural', 'structural_engineer'],
  ['carpentry', 'kitchen_carpentry'],
  ['painting', 'handyman'],

  // --- ticket categories that are not also trade tokens ---
  ['fire', 'fire_safety'],
  ['sewage', 'drainage'],
  ['water', 'water_tank'],
  ['lock', 'locksmith'],
  ['common_area', 'cleaning'],
  ['other', 'handyman'],

  // --- how suppliers describe themselves in English ---
  ['plumbing works', 'plumber'],
  ['plumbing services', 'plumber'],
  ['electro mechanical', 'electrician'],
  ['mep', 'electrician'],
  ['air conditioning', 'hvac'],
  ['ac', 'hvac'],
  ['a c', 'hvac'],
  ['chiller', 'hvac'],
  ['hvac contractor', 'hvac'],
  ['lift', 'elevator'],
  ['lifts', 'elevator'],
  ['elevators', 'elevator'],
  ['generators', 'generator'],
  ['water pump', 'plumber'],
  ['water pumps', 'plumber'],
  ['water heater', 'plumber'],
  ['boiler', 'plumber'],
  ['pest control services', 'pest_control'],
  ['cleaning services', 'cleaning'],
  ['handyman services', 'handyman'],
  ['maintenance', 'handyman'],
  ['roofing', 'roofer_waterproofing'],
  ['roof', 'roofer_waterproofing'],
  ['waterproofing', 'roofer_waterproofing'],
  ['insulation', 'roofer_waterproofing'],
  ['cctv', 'security_systems'],
  ['security', 'security_systems'],
  ['access control', 'security_systems'],
  ['intercom', 'security_systems'],
  ['gate automation', 'gate_automation'],
  ['parking equipment', 'gate_automation'],
  ['barrier', 'gate_automation'],
  ['signage', 'signage_install'],
  ['signs', 'signage_install'],
  ['solar', 'solar_pv'],
  ['solar pv', 'solar_pv'],
  ['photovoltaic', 'solar_pv'],
  ['drainage services', 'drainage'],
  ['sewer', 'drainage'],
  ['septic', 'drainage'],

  // --- how a Jordanian roster describes itself in Arabic ---
  ['سباكة', 'plumber'],
  ['سباك', 'plumber'],
  ['سباكة وصرف صحي', 'plumber'],
  ['كهرباء', 'electrician'],
  ['كهربائي', 'electrician'],
  ['كهرباء عامة', 'electrician'],
  ['تمديدات كهربائية', 'electrician'],
  ['تكييف', 'hvac'],
  ['تكييف وتبريد', 'hvac'],
  ['تبريد', 'hvac'],
  ['مكيفات', 'hvac'],
  ['مصعد', 'elevator'],
  ['مصاعد', 'elevator'],
  ['غاز', 'gas_safety'],
  ['تمديدات غاز', 'gas_safety'],
  ['حريق', 'fire_safety'],
  ['اطفاء', 'fire_safety'],
  ['إطفاء', 'fire_safety'],
  ['انذار حريق', 'fire_safety'],
  ['إنذار حريق', 'fire_safety'],
  ['صرف صحي', 'drainage'],
  ['تسليك', 'drainage'],
  ['مجاري', 'drainage'],
  ['خزان', 'water_tank'],
  ['خزانات', 'water_tank'],
  ['خزانات مياه', 'water_tank'],
  ['مولد', 'generator'],
  ['مولدة', 'generator'],
  ['مولدات', 'generator'],
  ['تنظيف', 'cleaning'],
  ['مكافحة حشرات', 'pest_control'],
  ['حشرات', 'pest_control'],
  ['نجارة', 'kitchen_carpentry'],
  ['مطابخ', 'kitchen_carpentry'],
  ['دهان', 'handyman'],
  ['صيانة عامة', 'handyman'],
  ['حداد', 'handyman'],
  ['اقفال', 'locksmith'],
  ['أقفال', 'locksmith'],
  ['مفاتيح', 'locksmith'],
  ['كاميرات', 'security_systems'],
  ['كاميرات مراقبة', 'security_systems'],
  ['انظمة امنية', 'security_systems'],
  ['سولار', 'solar_pv'],
  ['طاقة شمسية', 'solar_pv'],
  ['الواح شمسية', 'solar_pv'],
  ['لافتات', 'signage_install'],
  ['بوابات', 'gate_automation'],
  ['حاجز', 'gate_automation'],
  ['عزل', 'roofer_waterproofing'],
  ['عزل اسطح', 'roofer_waterproofing'],
  ['اسطح', 'roofer_waterproofing'],
  ['مهندس انشائي', 'structural_engineer'],
  ['انشائي', 'structural_engineer'],
];

const ALIASES: ReadonlyMap<string, Trade> = (() => {
  const map = new Map<string, Trade>();
  for (const [word, trade] of ALIAS_PAIRS) {
    const key = foldTradeWord(word);
    const existing = map.get(key);
    if (existing !== undefined && existing !== trade) {
      // Two different trades claiming one word is an ambiguity, not a default.
      throw new Error(`ambiguous trade alias "${word}": ${existing} vs ${trade}`);
    }
    map.set(key, trade);
  }
  return map;
})();

const TOKEN_SET: ReadonlySet<string> = new Set(TRADE_TOKENS.map(foldTradeWord));

/** True when the string is already a canonical trade token. */
export function isTrade(value: string): value is Trade {
  return TOKEN_SET.has(foldTradeWord(value));
}

/**
 * The only way to read a trade out of free text. Returns `null` for a word we do
 * not recognise — the caller decides whether that is an error or a new trade,
 * and neither the console nor the agent gets to invent a fourth vocabulary
 * silently.
 */
export function canonicalTrade(value: string): Trade | null {
  const key = foldTradeWord(value);
  if (key === '') return null;
  const token = TRADE_TOKENS.find((t) => foldTradeWord(t) === key);
  if (token !== undefined) return token;
  return ALIASES.get(key) ?? null;
}

/**
 * Every spelling we accept for a trade, canonical form included. Used when a
 * query has to reach rows that were written before `canonicalTrade` existed.
 */
export function tradeSpellings(trade: Trade): readonly string[] {
  const folded = foldTradeWord(trade);
  const spellings: string[] = [trade];
  const seen = new Set<string>([folded]);
  for (const [word, mapped] of ALIAS_PAIRS) {
    if (mapped !== trade) continue;
    const key = foldTradeWord(word);
    // «اقفال» and «أقفال» are the same word after folding; listing both would
    // suggest a distinction the matcher does not make.
    if (seen.has(key)) continue;
    seen.add(key);
    spellings.push(word);
  }
  return spellings;
}
