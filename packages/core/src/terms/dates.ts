import type { IsoDate } from '@aqar/contracts';
import { addDaysISO, assertNonNegativeInteger, parseIsoDate } from './internal.js';

export interface DateWindow {
  readonly startISO: IsoDate;
  readonly endISO: IsoDate;
}

/**
 * Latest date a tenant may serve notice: lease end minus `noticeDays`
 * calendar days, computed on the proleptic Gregorian calendar in UTC.
 */
export function noticeDeadline(leaseEndISO: string, noticeDays: number): IsoDate {
  const endISO = parseIsoDate(leaseEndISO, 'leaseEndISO');
  assertNonNegativeInteger(noticeDays, 'noticeDays');
  return addDaysISO(endISO, -noticeDays);
}

/** The window in which a renewal offer must be sent, ending on the lease end date. */
export function renewalOfferWindow(leaseEndISO: string, offerDaysBefore: number): DateWindow {
  const endISO = parseIsoDate(leaseEndISO, 'leaseEndISO');
  assertNonNegativeInteger(offerDaysBefore, 'offerDaysBefore');
  return { startISO: addDaysISO(endISO, -offerDaysBefore), endISO };
}
