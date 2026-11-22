import type { Trade } from './trades.js';
import type { EquipmentKind } from './equipment-trades.js';

/**
 * What a trade is expected to do on a schedule, as opposed to what it does when
 * something breaks.
 *
 * `service_standards` holds SLA clocks (how fast an emergency must be answered);
 * nothing held preventive cadence, so every recurring obligation in the product
 * was a calendar note in someone's head. Three of them are not preferences at
 * all — an elevator that misses its inspection, an extinguisher that is never
 * refilled and a gas installation done by an uncertified hand are all the
 * landlord's legal exposure, and `aqar` had no way to warn before the clock ran
 * out.
 *
 * Nothing here is hard-coded statute. `cadenceDays` is a *default* that belongs
 * to a config pack (the Amman pack today), and `cadenceBasis` says where the
 * number came from: `statutory` intervals must be confirmed against the current
 * fee/inspection schedule before they are relied on, and changing one is a data
 * edit, not a code change.
 */

export type CadenceBasis = 'statutory' | 'manufacturer' | 'recommended';

export interface JobTemplate {
  /** Stable identifier; also the row key in `trade_job_templates`. */
  readonly code: string;
  readonly trade: Trade;
  readonly titleEn: string;
  readonly titleAr: string;
  /** Days between visits. `null` means the job only exists when something fails. */
  readonly cadenceDays: number | null;
  readonly cadenceBasis: CadenceBasis | null;
  /** True when the obligation comes from an authority, not from the trade. */
  readonly statutory: boolean;
  /** Who can refuse the building service: GAM, the civil defence, the utility. */
  readonly statutoryAuthority: 'GAM' | 'CDD' | null;
  /** True when the work itself requires a licensed/certified technician. */
  readonly requiresCertificate: boolean;
  readonly equipmentKinds: readonly EquipmentKind[];
  readonly notes: string | null;
}

export const JOB_TEMPLATES: readonly JobTemplate[] = [
  {
    code: 'elevator_periodic_maintenance',
    trade: 'elevator',
    titleEn: 'Elevator preventive maintenance',
    titleAr: 'صيانة وقائية للمصعد',
    // Every 30 days is the maintenance contract rhythm in Amman, not a statute:
    // the statutory act is the inspection below.
    cadenceDays: 30,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['elevator'],
    notes: 'Maintenance contract; the licence depends on the statutory inspection.',
  },
  {
    code: 'elevator_statutory_inspection',
    trade: 'elevator',
    titleEn: 'Elevator statutory inspection and licence renewal',
    titleAr: 'كشف وتجديد رخصة المصعد',
    cadenceDays: 365,
    cadenceBasis: 'statutory',
    statutory: true,
    statutoryAuthority: 'GAM',
    requiresCertificate: true,
    equipmentKinds: ['elevator'],
    // The consequence is not a fine: the lift leaves service, and the building
    // loses its only vertical route. This is the strongest clock in the product.
    notes: 'Confirm the current interval with GAM before relying on 365 days.',
  },
  {
    code: 'water_tank_clean',
    trade: 'water_tank',
    titleEn: 'Water tank clean and disinfect',
    titleAr: 'تنظيف وتعقيم خزان المياه',
    cadenceDays: 90,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['water_tank'],
    notes: 'Quarterly is the health-driven default; a rooftop tank in summer is worse.',
  },
  {
    code: 'gas_leak_response',
    trade: 'gas_safety',
    titleEn: 'Gas leak callout',
    titleAr: 'كشف تسرب غاز',
    cadenceDays: null,
    cadenceBasis: null,
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['gas_network', 'gas_cylinder'],
    notes: 'Reactive. The technician must be certified: an uncertified repair voids cover.',
  },
  {
    code: 'gas_installation_certificate',
    trade: 'gas_safety',
    titleEn: 'Gas installation certificate',
    titleAr: 'شهادة سلامة تمديدات الغاز',
    cadenceDays: 365,
    cadenceBasis: 'statutory',
    statutory: true,
    statutoryAuthority: 'GAM',
    requiresCertificate: true,
    equipmentKinds: ['gas_network'],
    notes: 'Confirm interval and issuing body before relying on 365 days.',
  },
  {
    code: 'fire_extinguisher_service',
    trade: 'fire_safety',
    titleEn: 'Fire extinguisher service',
    titleAr: 'صيانة طفايات الحريق',
    cadenceDays: 365,
    cadenceBasis: 'statutory',
    statutory: true,
    statutoryAuthority: 'CDD',
    requiresCertificate: true,
    equipmentKinds: ['fire_extinguisher'],
    notes: 'Annual service tag; the certificate is what an inspection asks for.',
  },
  {
    code: 'fire_alarm_test',
    trade: 'fire_safety',
    titleEn: 'Fire alarm system test',
    titleAr: 'فحص نظام إنذار الحريق',
    cadenceDays: 180,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['fire_alarm'],
    notes: 'Six-monthly test is the practice; confirm against the building classification.',
  },
  {
    code: 'fire_riser_pressure_test',
    trade: 'fire_safety',
    titleEn: 'Fire riser pressure test',
    titleAr: 'فحص ضغط شبكة الإطفاء',
    cadenceDays: 365,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['fire_riser'],
    notes: null,
  },
  {
    code: 'plumbing_leak_repair',
    trade: 'plumber',
    titleEn: 'Plumbing leak repair',
    titleAr: 'إصلاح تسرب',
    cadenceDays: null,
    cadenceBasis: null,
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['water_supply', 'pump', 'plumbing_fixture'],
    notes: 'Highest call volume in an old Weibdeh building.',
  },
  {
    code: 'pump_service',
    trade: 'plumber',
    titleEn: 'Booster pump service',
    titleAr: 'صيانة مضخة المياه',
    cadenceDays: 365,
    cadenceBasis: 'manufacturer',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['pump'],
    notes: 'Roof tank plus booster pump is the standard Weibdeh arrangement.',
  },
  {
    code: 'drainage_jetting',
    trade: 'drainage',
    titleEn: 'Drain and sewer jetting',
    titleAr: 'تسليك المجاري بالضغط',
    cadenceDays: 365,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['drainage', 'sewer'],
    notes: 'Older clay runs benefit from an annual pass before the winter.',
  },
  {
    code: 'electrical_panel_inspection',
    trade: 'electrician',
    titleEn: 'Electrical panel thermographic inspection',
    titleAr: 'فحص لوحة الكهرباء',
    cadenceDays: 365,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['electrical_panel', 'wiring'],
    notes: 'Aluminium wiring in 1970s stock is the reason this exists.',
  },
  {
    code: 'hvac_split_service',
    trade: 'hvac',
    titleEn: 'Split unit service',
    titleAr: 'صيانة مكيف سبليت',
    cadenceDays: 180,
    cadenceBasis: 'manufacturer',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['hvac_split'],
    notes: 'Twice a year: before summer, after summer.',
  },
  {
    code: 'hvac_central_service',
    trade: 'hvac',
    titleEn: 'Central chiller/boiler service',
    titleAr: 'صيانة التكييف المركزي',
    cadenceDays: 90,
    cadenceBasis: 'manufacturer',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['hvac_central'],
    notes: 'A chiller technician is not a split-unit technician; rate cards differ by multiples.',
  },
  {
    code: 'generator_service',
    trade: 'generator',
    titleEn: 'Generator service and load test',
    titleAr: 'صيانة المولد وفحص الحمل',
    cadenceDays: 90,
    cadenceBasis: 'manufacturer',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['generator'],
    notes: null,
  },
  {
    code: 'water_heater_service',
    trade: 'plumber',
    titleEn: 'Water heater service',
    titleAr: 'صيانة سخان المياه',
    cadenceDays: 365,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['water_heater'],
    notes: 'Anode/scale check; the electric variant lands with the electrician instead.',
  },
  {
    code: 'locksmith_callout',
    trade: 'locksmith',
    titleEn: 'Lock and key callout',
    titleAr: 'فتح أقفال',
    cadenceDays: null,
    cadenceBasis: null,
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['door_lock'],
    notes: null,
  },
  {
    code: 'appliance_repair',
    trade: 'appliance_repair',
    titleEn: 'Appliance repair',
    titleAr: 'إصلاح أجهزة',
    cadenceDays: null,
    cadenceBasis: null,
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['appliance'],
    notes: 'Usually the tenant who calls, the landlord who pays only if the appliance is his.',
  },
  {
    code: 'pest_control',
    trade: 'pest_control',
    titleEn: 'Pest control treatment',
    titleAr: 'مكافحة حشرات',
    cadenceDays: 365,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['other'],
    notes: 'Common areas and refuse shafts; the treatment certificate matters for tenants.',
  },
  {
    code: 'common_area_cleaning',
    trade: 'cleaning',
    titleEn: 'Common area cleaning',
    titleAr: 'تنظيف المناطق المشتركة',
    cadenceDays: 7,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['other'],
    notes: 'The stairwell and the roof are the two surfaces tenants judge the building by.',
  },
  {
    code: 'roof_waterproofing_survey',
    trade: 'roofer_waterproofing',
    titleEn: 'Roof waterproofing survey',
    titleAr: 'فحص عزل السطح',
    cadenceDays: 730,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['roof', 'envelope', 'structure'],
    notes: 'Biennial survey, always before the first winter rain rather than after.',
  },
  {
    code: 'solar_pv_service',
    trade: 'solar_pv',
    titleEn: 'Solar PV service',
    titleAr: 'صيانة الألواح الشمسية',
    cadenceDays: 365,
    cadenceBasis: 'manufacturer',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['solar'],
    notes: 'Panel clean plus inverter check; the utility agreement is a separate clock.',
  },
  {
    code: 'security_systems_check',
    trade: 'security_systems',
    titleEn: 'CCTV, intercom and access control check',
    titleAr: 'فحص الكاميرات والانتركم',
    cadenceDays: 180,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['cctv', 'intercom', 'security_access'],
    notes: 'Retention/legal basis for footage belongs with the privacy policy, not here.',
  },
  {
    code: 'gate_automation_service',
    trade: 'gate_automation',
    titleEn: 'Parking barrier service',
    titleAr: 'صيانة حاجز المواقف',
    cadenceDays: 180,
    cadenceBasis: 'manufacturer',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['parking_equipment'],
    notes: null,
  },
  {
    code: 'signage_permit_renewal',
    trade: 'signage_install',
    titleEn: 'Commercial signage permit renewal',
    titleAr: 'تجديد ترخيص اللافتات',
    cadenceDays: 365,
    cadenceBasis: 'statutory',
    statutory: true,
    statutoryAuthority: 'GAM',
    requiresCertificate: false,
    equipmentKinds: ['signage'],
    notes: 'Only for commercial units; confirm the fee schedule with GAM.',
  },
  {
    code: 'structural_survey',
    trade: 'structural_engineer',
    titleEn: 'Structural survey',
    titleAr: 'فحص إنشائي',
    cadenceDays: 1825,
    cadenceBasis: 'recommended',
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: true,
    equipmentKinds: ['structure', 'envelope'],
    notes: 'Five-yearly for pre-1980 stock; a crack is not the time to look for the file.',
  },
  {
    code: 'kitchen_carpentry_callout',
    trade: 'kitchen_carpentry',
    titleEn: 'Kitchen and joinery callout',
    titleAr: 'صيانة مطابخ ونجارة',
    cadenceDays: null,
    cadenceBasis: null,
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['kitchen'],
    notes: null,
  },
  {
    code: 'handyman_callout',
    trade: 'handyman',
    titleEn: 'General handyman callout',
    titleAr: 'صيانة عامة',
    cadenceDays: null,
    cadenceBasis: null,
    statutory: false,
    statutoryAuthority: null,
    requiresCertificate: false,
    equipmentKinds: ['other', 'lighting'],
    notes: 'The catch-all: if a job cannot name its trade, it lands here.',
  },
];

const BY_CODE: ReadonlyMap<string, JobTemplate> = new Map(
  JOB_TEMPLATES.map((template) => [template.code, template]),
);

export function templateForCode(code: string): JobTemplate | null {
  return BY_CODE.get(code) ?? null;
}

export function templatesForTrade(trade: Trade): readonly JobTemplate[] {
  return JOB_TEMPLATES.filter((template) => template.trade === trade);
}

export function templatesForEquipmentKind(kind: EquipmentKind): readonly JobTemplate[] {
  return JOB_TEMPLATES.filter((template) => template.equipmentKinds.includes(kind));
}

/** Every obligation the building can be refused service over. */
export function statutoryTemplates(): readonly JobTemplate[] {
  return JOB_TEMPLATES.filter((template) => template.statutory);
}
