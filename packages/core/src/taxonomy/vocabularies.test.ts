import { describe, expect, it } from 'vitest';
import type { Trade } from './trades.js';
import {
  TRADE_TOKENS,
  canonicalTrade,
  foldTradeWord,
  isTrade,
  tradeSpellings,
} from './trade-aliases.js';
import {
  EQUIPMENT_KINDS,
  EQUIPMENT_TRADE,
  equipmentKindsForTrade,
  primaryTradeForEquipmentKind,
} from './equipment-trades.js';
import { JOB_TEMPLATES, statutoryTemplates, templatesForTrade } from './job-templates.js';

/**
 * These four vocabularies have to agree with each other and with the database.
 * Each assertion below is a way they silently drifted before: a trade nobody can
 * be dispatched for, an asset kind with no trade, a statute with no clock, or a
 * word that meant two different things depending on which module read it.
 */

const LEGACY_VENDOR_TRADES = [
  'plumbing',
  'electrical',
  'hvac',
  'gas',
  'elevator',
  'cleaning',
  'carpentry',
  'pest',
  'appliance',
  'generator',
  'painting',
  'locksmith',
  'structural',
] as const;

describe('trade vocabulary', () => {
  it('exposes every trade as a token, and only trades', () => {
    expect(TRADE_TOKENS).toHaveLength(21);
    expect(new Set(TRADE_TOKENS).size).toBe(21);
    for (const token of TRADE_TOKENS) expect(isTrade(token)).toBe(true);
  });

  it('canonicalises its own tokens, idempotently', () => {
    for (const token of TRADE_TOKENS) {
      expect(canonicalTrade(token)).toBe(token);
      expect(canonicalTrade(token.toUpperCase())).toBe(token);
      expect(canonicalTrade(`  ${token}  `)).toBe(token);
    }
  });

  it('absorbs every word the retired VendorTrade vocabulary used', () => {
    for (const word of LEGACY_VENDOR_TRADES) {
      const trade = canonicalTrade(word);
      expect(trade, `"${word}" must resolve to a trade`).not.toBeNull();
      expect(isTrade(trade as Trade)).toBe(true);
    }
  });

  it('resolves the category names that were used as trades', () => {
    expect(canonicalTrade('plumbing')).toBe('plumber');
    expect(canonicalTrade('electrical')).toBe('electrician');
    expect(canonicalTrade('gas')).toBe('gas_safety');
    expect(canonicalTrade('appliance')).toBe('appliance_repair');
    expect(canonicalTrade('sewage')).toBe('drainage');
    expect(canonicalTrade('fire')).toBe('fire_safety');
    expect(canonicalTrade('lock')).toBe('locksmith');
  });

  it('resolves how a Jordanian roster writes the same trades', () => {
    // Folding handles harakat, tatweel and alef variants; these are the real
    // spellings, not cleaned-up ones.
    expect(canonicalTrade('سباكة')).toBe('plumber');
    expect(canonicalTrade('سـبـاكة')).toBe('plumber');
    expect(canonicalTrade('سبّاك')).toBe('plumber');
    expect(canonicalTrade('كهرباء')).toBe('electrician');
    expect(canonicalTrade('تكييف وتبريد')).toBe('hvac');
    expect(canonicalTrade('مصاعد')).toBe('elevator');
    expect(canonicalTrade('خزانات مياه')).toBe('water_tank');
    expect(canonicalTrade('مكافحة حشرات')).toBe('pest_control');
    expect(canonicalTrade('طاقة شمسية')).toBe('solar_pv');
    expect(canonicalTrade('إنذار حريق')).toBe('fire_safety');
  });

  it('returns null rather than guessing at a word it has never seen', () => {
    expect(canonicalTrade('')).toBeNull();
    expect(canonicalTrade('   ')).toBeNull();
    expect(canonicalTrade('blacksmith')).toBeNull();
    expect(canonicalTrade('عطارة')).toBeNull();
  });

  it('folds without losing the distinction between different words', () => {
    expect(foldTradeWord('سباكة')).toBe(foldTradeWord('سباكه'));
    expect(foldTradeWord('HVAC')).toBe(foldTradeWord('hvac'));
    expect(foldTradeWord('سباكة')).not.toBe(foldTradeWord('كهرباء'));
  });

  it('lists every spelling it accepts, canonical first', () => {
    const spellings = tradeSpellings('plumber');
    expect(spellings[0]).toBe('plumber');
    expect(spellings).toContain('plumbing');
    expect(spellings).toContain('سباكة');
    expect(new Set(spellings.map(foldTradeWord)).size).toBe(spellings.length);
  });
});

describe('equipment kind -> trade join', () => {
  it('covers all 32 kinds, which is what 0018 declares', () => {
    expect(EQUIPMENT_KINDS).toHaveLength(32);
    expect(new Set(EQUIPMENT_KINDS).size).toBe(32);
    for (const kind of EQUIPMENT_KINDS) {
      expect(EQUIPMENT_TRADE[kind], `kind ${kind} has no trade`).toBeDefined();
    }
  });

  it('never points at a trade that does not exist', () => {
    for (const kind of EQUIPMENT_KINDS) {
      for (const trade of EQUIPMENT_TRADE[kind]) {
        expect(isTrade(trade), `${kind} -> ${trade} is not a token`).toBe(true);
      }
    }
  });

  it('names exactly one primary trade per kind', () => {
    for (const kind of EQUIPMENT_KINDS) {
      const primary = primaryTradeForEquipmentKind(kind);
      expect(primary).toBe(EQUIPMENT_TRADE[kind][0]);
      expect(primary).not.toBe('');
    }
  });

  it('agrees with its own inverse', () => {
    for (const kind of EQUIPMENT_KINDS) {
      for (const trade of EQUIPMENT_TRADE[kind]) {
        expect(equipmentKindsForTrade(trade)).toContain(kind);
      }
    }
  });

  it('covers the kinds that used to have no trade at all', () => {
    for (const kind of [
      'cctv',
      'intercom',
      'security_access',
      'solar',
      'kitchen',
      'parking_equipment',
      'signage',
      'roof',
      'envelope',
    ] as const) {
      expect(EQUIPMENT_TRADE[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('job templates', () => {
  it('uses unique codes and existing trades', () => {
    const codes = JOB_TEMPLATES.map((template) => template.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const template of JOB_TEMPLATES) {
      expect(isTrade(template.trade), `${template.code} -> ${template.trade}`).toBe(true);
    }
  });

  it('gives every trade somewhere for a job to land', () => {
    for (const trade of TRADE_TOKENS) {
      expect(templatesForTrade(trade).length, `no template for ${trade}`).toBeGreaterThan(0);
    }
  });

  it('never leaves a statutory obligation without a clock and an authority', () => {
    const statutory = statutoryTemplates();
    expect(statutory.length).toBeGreaterThan(0);
    for (const template of statutory) {
      expect(template.cadenceDays, `${template.code} is statutory but reactive`).not.toBeNull();
      expect(template.cadenceBasis).toBe('statutory');
      expect(template.statutoryAuthority, `${template.code} names no authority`).not.toBeNull();
    }
  });

  it('marks a non-statutory template as such, with no authority', () => {
    for (const template of JOB_TEMPLATES) {
      if (template.statutory) continue;
      expect(template.statutoryAuthority).toBeNull();
    }
  });

  it('gives a cadence a basis, and a reactive job none', () => {
    for (const template of JOB_TEMPLATES) {
      if (template.cadenceDays === null) {
        expect(template.cadenceBasis, `${template.code}`).toBeNull();
      } else {
        expect(template.cadenceDays).toBeGreaterThan(0);
        expect(template.cadenceBasis, `${template.code}`).not.toBeNull();
      }
    }
  });

  it('only references equipment kinds that exist', () => {
    const kinds = new Set<string>(EQUIPMENT_KINDS);
    for (const template of JOB_TEMPLATES) {
      for (const kind of template.equipmentKinds) {
        expect(kinds.has(kind), `${template.code} -> ${kind}`).toBe(true);
      }
    }
  });

  it('covers the statutory instruments the GAM layer cares about', () => {
    const codes = statutoryTemplates().map((template) => template.code);
    expect(codes).toContain('elevator_statutory_inspection');
    expect(codes).toContain('fire_extinguisher_service');
    expect(codes).toContain('signage_permit_renewal');
  });
});
