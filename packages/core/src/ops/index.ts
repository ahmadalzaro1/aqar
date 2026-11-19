// Public surface of the pure ops engine (LAW 1: no I/O, no LLM, no wall clock).
export {
  emergencyPrecheck,
  hazardSignalCategory,
  HAZARD_SIGNALS,
} from './emergency.js';
export type { HazardSignal, HazardSignalId } from './emergency.js';

export { normalizeText } from './normalize.js';

export { mergeClassification } from './merge.js';

export {
  safetyInstructions,
  SAFETY_INSTRUCTIONS,
  JORDAN_EMERGENCY_NUMBER,
} from './safety.js';
export type { SafetyInstructionSet, SafetyLocale } from './safety.js';

export { defaultServiceStandard, slaDueDates, slaState } from './sla.js';
export type { SlaDueDates } from './sla.js';

export { evaluatePolicy } from './policy.js';

export { vendorScore } from './vendor.js';

export {
  occupancyRate,
  delinquencyRateBps,
  collectionRateBps,
  noiFils,
  workOrderAging,
  meanTimeToResolutionHours,
  leaseRollForecast,
  vendorSpendFils,
  propertyPnl,
} from './metrics.js';
export type {
  UnitStatus,
  OccupancyUnit,
  WorkOrderStatus,
  AgingWorkOrder,
  WorkOrderAging,
  ResolvedWorkOrder,
  LeaseRollEntry,
  LeaseRollBucket,
  VendorInvoice,
  VendorSpend,
  PropertyPnlRow,
  PropertyPnl,
} from './metrics.js';
