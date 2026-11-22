/**
 * A maintenance request is a fact about the world ("smell of gas"); a trade is a
 * capability ("someone certified to make gas safe"). The mapping between them is
 * the whole dispatch problem, and it is data.
 *
 * `severityFloor` is the part that matters for safety (LAW 2): a request about
 * gas, fire or a live electrical fault cannot be recorded below `higher` severity
 * no matter how calmly the tenant describes it. A model may raise it further; the
 * floor is deterministic and cannot be lowered.
 */

export type TicketCategory =
  | 'gas'
  | 'fire'
  | 'electrical'
  | 'plumbing'
  | 'sewage'
  | 'water'
  | 'hvac'
  | 'structural'
  | 'lock'
  | 'elevator'
  | 'appliance'
  | 'pest'
  | 'common_area'
  | 'generator'
  | 'other';

/** Ordered so comparisons are meaningful: higher index = more urgent. */
export const SEVERITY_ORDER = ['cosmetic', 'low', 'medium', 'high', 'emergency'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export type Trade =
  | 'gas_safety'
  | 'fire_safety'
  | 'electrician'
  | 'plumber'
  | 'drainage'
  | 'water_tank'
  | 'hvac'
  | 'structural_engineer'
  | 'locksmith'
  | 'elevator'
  | 'appliance_repair'
  | 'pest_control'
  | 'cleaning'
  | 'generator'
  | 'handyman';

export interface CategoryProfile {
  readonly trade: Trade;
  readonly severityFloor: Severity;
  /** True when the category can be an emergency and bypasses triage. */
  readonly emergencyCapable: boolean;
  /** Guidance key the agent must surface verbatim for emergency-capable cases. */
  readonly safetyInstruction: string | null;
}

export const CATEGORY_PROFILES: Readonly<Record<TicketCategory, CategoryProfile>> = {
  gas: {
    trade: 'gas_safety',
    severityFloor: 'emergency',
    emergencyCapable: true,
    safetyInstruction: 'gas_smell',
  },
  fire: {
    trade: 'fire_safety',
    severityFloor: 'emergency',
    emergencyCapable: true,
    safetyInstruction: 'fire',
  },
  electrical: {
    trade: 'electrician',
    severityFloor: 'high',
    emergencyCapable: true,
    safetyInstruction: 'electrical_shock',
  },
  plumbing: {
    trade: 'plumber',
    severityFloor: 'medium',
    emergencyCapable: true,
    safetyInstruction: 'water_damage',
  },
  sewage: {
    trade: 'drainage',
    severityFloor: 'high',
    emergencyCapable: true,
    safetyInstruction: 'sewage_health',
  },
  water: {
    trade: 'water_tank',
    severityFloor: 'medium',
    emergencyCapable: true,
    safetyInstruction: 'water_damage',
  },
  hvac: {
    trade: 'hvac',
    severityFloor: 'medium',
    emergencyCapable: false,
    safetyInstruction: null,
  },
  structural: {
    trade: 'structural_engineer',
    severityFloor: 'high',
    emergencyCapable: true,
    safetyInstruction: 'collapse_risk',
  },
  lock: {
    trade: 'locksmith',
    severityFloor: 'medium',
    emergencyCapable: true,
    safetyInstruction: 'locked_out',
  },
  elevator: {
    trade: 'elevator',
    severityFloor: 'high',
    emergencyCapable: true,
    safetyInstruction: 'trapped_in_lift',
  },
  appliance: {
    trade: 'appliance_repair',
    severityFloor: 'low',
    emergencyCapable: false,
    safetyInstruction: null,
  },
  pest: {
    trade: 'pest_control',
    severityFloor: 'low',
    emergencyCapable: false,
    safetyInstruction: null,
  },
  common_area: {
    trade: 'cleaning',
    severityFloor: 'cosmetic',
    emergencyCapable: false,
    safetyInstruction: null,
  },
  generator: {
    trade: 'generator',
    severityFloor: 'medium',
    emergencyCapable: true,
    safetyInstruction: 'power_outage',
  },
  other: {
    trade: 'handyman',
    severityFloor: 'low',
    emergencyCapable: false,
    safetyInstruction: null,
  },
};

export const TICKET_CATEGORIES = Object.keys(CATEGORY_PROFILES) as readonly TicketCategory[];

export function tradeFor(category: TicketCategory): Trade {
  return CATEGORY_PROFILES[category].trade;
}

/** The floor, as an index into SEVERITY_ORDER, so a comparison is a number. */
export function severityFloorIndex(category: TicketCategory): number {
  return SEVERITY_ORDER.indexOf(CATEGORY_PROFILES[category].severityFloor);
}

/**
 * A model may raise severity, never lower it. This is the deterministic half of
 * LAW 2 and the reason a liquid-sounding message cannot downgrade a gas leak.
 */
export function applySeverityFloor(category: TicketCategory, claimed: Severity): Severity {
  const floor = severityFloorIndex(category);
  return SEVERITY_ORDER.indexOf(claimed) >= floor
    ? claimed
    : (SEVERITY_ORDER[floor] ?? 'emergency');
}

export function isEmergencyCapable(category: TicketCategory): boolean {
  return CATEGORY_PROFILES[category].emergencyCapable;
}
