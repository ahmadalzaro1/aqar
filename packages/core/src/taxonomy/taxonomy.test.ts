import { describe, expect, it } from 'vitest';
import {
  CHARGE_KINDS,
  CHARGE_SEMANTICS,
  isTrustMoney,
  needsHumanClassification,
} from './charges.js';
import {
  BILLING_CYCLES,
  DEFAULT_NOTICE_DAYS,
  DEPOSIT_MONTHS_CAP,
  LEASE_KINDS,
  allowedCycles,
  cycleAllowed,
  defaultLeaseKind,
  invoicesPerYear,
} from './leases.js';
import {
  DETAIL_TABLE,
  SPACE_DETAIL,
  SPACE_KINDS,
  missingPublishAttributes,
  needsBuilding,
  spaceAllowsLeaseKind,
  type SpaceKind,
} from './spaces.js';
import {
  CATEGORY_PROFILES,
  SEVERITY_ORDER,
  TICKET_CATEGORIES,
  applySeverityFloor,
  severityFloorIndex,
  tradeFor,
} from './trades.js';

describe('space taxonomy', () => {
  it('gives every kind a detail family and a table that exists', () => {
    for (const kind of SPACE_KINDS) {
      const family = SPACE_DETAIL[kind];
      expect(family).toBeDefined();
      expect(DETAIL_TABLE[family]).toBeTruthy();
    }
  });

  it('says land has no building and a flat must have one', () => {
    expect(needsBuilding('land')).toBe(false);
    expect(needsBuilding('farm')).toBe(false);
    expect(needsBuilding('rooftop')).toBe(false);
    expect(needsBuilding('flat')).toBe(true);
    expect(needsBuilding('warehouse')).toBe(true);
  });

  it('refuses to let a warehouse be described as publishable without a clear height', () => {
    expect(missingPublishAttributes('warehouse', { area_sqm: 400, dock_doors: 2 })).toEqual([
      'clear_height_m',
    ]);
    expect(
      missingPublishAttributes('warehouse', { area_sqm: 400, dock_doors: 2, clear_height_m: 7.5 }),
    ).toEqual([]);
    // Parking needs nothing beyond its number: the bay is the spec.
    expect(missingPublishAttributes('parking', {})).toEqual([]);
  });

  it('does not let a bare-land lease attach to a flat', () => {
    expect(spaceAllowsLeaseKind('flat', 'bare_land')).toBe(false);
    expect(spaceAllowsLeaseKind('land', 'bare_land')).toBe(true);
    expect(spaceAllowsLeaseKind('warehouse', 'residential')).toBe(false);
    expect(spaceAllowsLeaseKind('warehouse', 'industrial')).toBe(true);
    expect(spaceAllowsLeaseKind('shop', 'short_term')).toBe(true);
  });

  it('maps each space to the default lease kind the console should preselect', () => {
    const kind: SpaceKind = 'cold_store';
    expect(defaultLeaseKind(kind)).toBe('industrial');
    expect(defaultLeaseKind('signage')).toBe('bare_land');
    expect(defaultLeaseKind('parking')).toBe('parking');
    for (const space of SPACE_KINDS) {
      expect(spaceAllowsLeaseKind(space, defaultLeaseKind(space))).toBe(true);
    }
  });
});

describe('lease taxonomy', () => {
  it('bills agricultural land on a crop cycle, not monthly', () => {
    expect(cycleAllowed('agricultural', 'monthly')).toBe(false);
    expect(allowedCycles('agricultural')).toContain('annual');
    expect(allowedCycles('residential')).toContain('monthly');
  });

  it('counts invoices from the cycle deterministically', () => {
    expect(invoicesPerYear('monthly')).toBe(12);
    expect(invoicesPerYear('quarterly')).toBe(4);
    expect(invoicesPerYear('semi_annual')).toBe(2);
    expect(invoicesPerYear('annual')).toBe(1);
    // An upfront single payment is one bill for the whole term, not twelve.
    expect(invoicesPerYear('upfront_single')).toBe(1);
    for (const cycle of BILLING_CYCLES) {
      expect(Number.isInteger(invoicesPerYear(cycle))).toBe(true);
    }
  });

  it('defaults every kind to a positive notice period and deposit cap', () => {
    for (const kind of LEASE_KINDS) {
      expect(DEFAULT_NOTICE_DAYS[kind]).toBeGreaterThan(0);
      expect(DEPOSIT_MONTHS_CAP[kind]).toBeGreaterThan(0);
      expect(allowedCycles(kind).length).toBeGreaterThan(0);
    }
  });

  it('never allows a cycle outside the declared enum', () => {
    for (const kind of LEASE_KINDS) {
      for (const cycle of allowedCycles(kind)) {
        expect(BILLING_CYCLES).toContain(cycle);
      }
    }
  });
});

describe('charge taxonomy', () => {
  it("treats deposits as somebody else's money", () => {
    expect(isTrustMoney('deposit')).toBe(true);
    expect(isTrustMoney('fit_out_deposit')).toBe(true);
    expect(isTrustMoney('rent')).toBe(false);
    expect(isTrustMoney('vat')).toBe(true);
  });

  it('gives every kind complete semantics, with no blank classification', () => {
    for (const kind of CHARGE_KINDS) {
      const semantics = CHARGE_SEMANTICS[kind];
      expect(['tenant', 'landlord', 'shared']).toContain(semantics.bearer);
      expect(['income', 'liability', 'recovery']).toContain(semantics.classification);
      expect(semantics.statementGroup).toBeTruthy();
    }
    // Only `other` may proceed without a human deciding what it is.
    expect(CHARGE_KINDS.filter(needsHumanClassification)).toEqual(['other']);
  });

  it('refunds exactly the refundable kinds', () => {
    const refundable = CHARGE_KINDS.filter((kind) => CHARGE_SEMANTICS[kind].refundable);
    expect(refundable).toEqual(['deposit', 'fit_out_deposit']);
  });
});

describe('trade taxonomy', () => {
  it('gives every ticket category a trade and a floor', () => {
    for (const category of TICKET_CATEGORIES) {
      expect(tradeFor(category)).toBeTruthy();
      expect(SEVERITY_ORDER).toContain(CATEGORY_PROFILES[category].severityFloor);
    }
  });

  it('cannot record a gas leak below emergency', () => {
    expect(severityFloorIndex('gas')).toBe(SEVERITY_ORDER.indexOf('emergency'));
    expect(applySeverityFloor('gas', 'low')).toBe('emergency');
    expect(applySeverityFloor('gas', 'emergency')).toBe('emergency');
  });

  it('lifts a calmly-described sewage flood to its floor but lets a model escalate higher', () => {
    expect(applySeverityFloor('sewage', 'cosmetic')).toBe('high');
    expect(applySeverityFloor('plumbing', 'emergency')).toBe('emergency');
    // A cosmetic complaint is allowed to stay cosmetic.
    expect(applySeverityFloor('common_area', 'cosmetic')).toBe('cosmetic');
  });

  it('marks exactly the safety categories as emergency-capable', () => {
    const capable = TICKET_CATEGORIES.filter(
      (category) => CATEGORY_PROFILES[category].emergencyCapable,
    );
    expect(capable).toEqual([
      'gas',
      'fire',
      'electrical',
      'plumbing',
      'sewage',
      'water',
      'structural',
      'lock',
      'elevator',
      'generator',
    ]);
    for (const category of capable) {
      expect(CATEGORY_PROFILES[category].safetyInstruction).not.toBeNull();
    }
  });

  it('never lowers a severity, for any category or claim', () => {
    for (const category of TICKET_CATEGORIES) {
      const floor = severityFloorIndex(category);
      for (const [index, claimed] of SEVERITY_ORDER.entries()) {
        const result = applySeverityFloor(category, claimed);
        expect(SEVERITY_ORDER.indexOf(result)).toBeGreaterThanOrEqual(Math.max(index, floor));
      }
    }
  });
});
