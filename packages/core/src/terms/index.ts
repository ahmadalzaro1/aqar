// @aqar/core terms engine — PURE lease, owner and bank-reconciliation math.
// Money is integer fils; dates are ISO strings; no I/O, no wall clock.
export { prorateRent } from './proration.js';
export { escalationSchedule, escalationStepFils, rentForPeriod } from './escalation.js';
export { noticeDeadline, renewalOfferWindow } from './dates.js';
export type { DateWindow } from './dates.js';
export { depositRefund, distributionWaterfall, managementFee } from './cash.js';
export { allocateSharedService, splitByShares } from './shares.js';
export {
  dedupeBankLines,
  fingerprintBankLine,
  proposeOldestFirstAllocation,
  suggestMatch,
} from './bank.js';
export type { ChargesByLease, PayerProfile } from './bank.js';
export { chequeBounceReversal, chequeTransition } from './cheque.js';
export type { ChequeEvent, ChequeReversalEntry } from './cheque.js';
