import type { Trade } from './trades.js';

/**
 * Which trade fixes which kind of thing.
 *
 * This mapping did not exist. `equipment_kind` lived only in the database (32
 * values, 0018) and `Trade` lived only in the core taxonomy (15 values, now 21),
 * and nothing joined them: a ticket carried a trade, an asset carried a kind, and
 * the two never met. So the twin could tell you a pump had failed and dispatch
 * could tell you which plumber to send — but no code could connect those two
 * facts without a human retyping the answer.
 *
 * Ten kinds had no trade at all (`cctv`, `security_access`, `intercom`, `solar`,
 * `kitchen`, `parking_equipment`, `signage`, `envelope`, `roof`, `other`), which
 * is why six capabilities were added to `Trade`. A kind that cannot name its
 * trade is a kind nobody is dispatched for.
 *
 * Order matters: the first trade is the primary one — the default recipient of a
 * job on this kind of asset. The rest are the trades that may legitimately
 * answer, e.g. a water heater is plumbed or wired depending on the heater.
 */

export const EQUIPMENT_KINDS = [
  'structure',
  'roof',
  'envelope',
  'water_supply',
  'water_tank',
  'pump',
  'drainage',
  'sewer',
  'gas_network',
  'gas_cylinder',
  'electrical_panel',
  'wiring',
  'generator',
  'solar',
  'hvac_split',
  'hvac_central',
  'water_heater',
  'elevator',
  'fire_alarm',
  'fire_extinguisher',
  'fire_riser',
  'security_access',
  'cctv',
  'intercom',
  'door_lock',
  'kitchen',
  'appliance',
  'plumbing_fixture',
  'lighting',
  'parking_equipment',
  'signage',
  'other',
] as const;

export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export const EQUIPMENT_TRADE: Readonly<Record<EquipmentKind, readonly [Trade, ...Trade[]]>> = {
  structure: ['structural_engineer'],
  roof: ['roofer_waterproofing'],
  envelope: ['roofer_waterproofing', 'handyman'],
  water_supply: ['plumber'],
  water_tank: ['water_tank'],
  pump: ['plumber'],
  drainage: ['drainage'],
  sewer: ['drainage'],
  gas_network: ['gas_safety'],
  gas_cylinder: ['gas_safety'],
  electrical_panel: ['electrician'],
  wiring: ['electrician'],
  generator: ['generator'],
  solar: ['solar_pv'],
  hvac_split: ['hvac'],
  hvac_central: ['hvac'],
  water_heater: ['plumber', 'electrician'],
  elevator: ['elevator'],
  fire_alarm: ['fire_safety'],
  fire_extinguisher: ['fire_safety'],
  fire_riser: ['fire_safety'],
  security_access: ['security_systems'],
  cctv: ['security_systems'],
  intercom: ['security_systems', 'electrician'],
  door_lock: ['locksmith'],
  kitchen: ['kitchen_carpentry'],
  appliance: ['appliance_repair'],
  plumbing_fixture: ['plumber'],
  lighting: ['electrician', 'handyman'],
  parking_equipment: ['gate_automation'],
  signage: ['signage_install'],
  other: ['handyman'],
};

/** The trades that may answer for a kind of asset, primary first. */
export function tradesForEquipmentKind(kind: EquipmentKind): readonly Trade[] {
  return EQUIPMENT_TRADE[kind];
}

/** The primary trade — who a job lands on unless a human says otherwise. */
export function primaryTradeForEquipmentKind(kind: EquipmentKind): Trade {
  return EQUIPMENT_TRADE[kind][0];
}

/** The inverse: which kinds of asset a trade is expected to look after. */
export function equipmentKindsForTrade(trade: Trade): readonly EquipmentKind[] {
  return EQUIPMENT_KINDS.filter((kind) => EQUIPMENT_TRADE[kind].includes(trade));
}
