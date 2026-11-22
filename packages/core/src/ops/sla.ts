// SLA clocks. Configurable service-standard pack — NEVER presented as law.
// The pack is a conservative operating default a landlord can replace per property;
// nothing here is a statutory deadline.

import type { SlaState, ServiceStandard, Severity } from '@aqar/contracts';

type ClockMap = Partial<Record<Severity, { responseMinutes: number; resolutionMinutes: number }>>;

const MINUTE_MS = 60_000;

/**
 * Conservative default pack. Emergency = call now, respond now (0 minutes to
 * response, 4 hours to resolution), degrading by severity. Cosmetic work is
 * deliberately slow: it must never compete with a safety job for a technician.
 */
export function defaultServiceStandard(): ServiceStandard {
  return {
    id: 'jordan-default',
    name: 'الأردن — معيار خدمة افتراضي / Jordan default service standard',
    propertyClass: 'residential',
    clocks: {
      emergency: { responseMinutes: 0, resolutionMinutes: 240 },
      high: { responseMinutes: 240, resolutionMinutes: 1440 },
      medium: { responseMinutes: 1440, resolutionMinutes: 4320 },
      low: { responseMinutes: 2880, resolutionMinutes: 10080 },
      cosmetic: { responseMinutes: 4320, resolutionMinutes: 20160 },
    },
  };
}

function clockFor(
  standard: ServiceStandard,
  severity: Severity,
): { responseMinutes: number; resolutionMinutes: number } {
  const clocks: ClockMap = standard.clocks;
  const clock = clocks[severity];
  if (clock === undefined) {
    throw new Error(`service standard '${standard.id}' has no clock for severity '${severity}'`);
  }
  return clock;
}

function addMinutes(instantISO: string, minutes: number): string {
  const base = new Date(instantISO).getTime();
  if (Number.isNaN(base)) {
    throw new Error(`invalid ISO instant: '${instantISO}'`);
  }
  return new Date(base + minutes * MINUTE_MS).toISOString();
}

function instantOf(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`invalid ISO instant: '${iso}'`);
  }
  return ms;
}

export interface SlaDueDates {
  readonly responseDueISO: string;
  readonly resolutionDueISO: string;
}

/** Response and resolution deadlines, minute arithmetic from the opening instant. */
export function slaDueDates(
  standard: ServiceStandard,
  severity: Severity,
  openedAtISO: string,
): SlaDueDates {
  const clock = clockFor(standard, severity);
  return {
    responseDueISO: addMinutes(openedAtISO, clock.responseMinutes),
    resolutionDueISO: addMinutes(openedAtISO, clock.resolutionMinutes),
  };
}

/**
 * Breach state at `nowISO`.
 *
 * A null respondedAtISO / resolvedAtISO means "has not happened yet": the clock is
 * then breached exactly when now is past the deadline. A non-null timestamp decides
 * on its own — once recorded, later `now` values cannot un-breach it (monotonic).
 */
export function slaState(
  standard: ServiceStandard,
  severity: Severity,
  openedAtISO: string,
  respondedAtISO: string | null,
  resolvedAtISO: string | null,
  nowISO: string,
): SlaState {
  const due = slaDueDates(standard, severity, openedAtISO);
  const now = instantOf(nowISO);

  const responseBreached =
    respondedAtISO === null
      ? now > instantOf(due.responseDueISO)
      : instantOf(respondedAtISO) > instantOf(due.responseDueISO);

  const resolutionBreached =
    resolvedAtISO === null
      ? now > instantOf(due.resolutionDueISO)
      : instantOf(resolvedAtISO) > instantOf(due.resolutionDueISO);

  return {
    responseDueISO: due.responseDueISO,
    resolutionDueISO: due.resolutionDueISO,
    responseBreached,
    resolutionBreached,
  };
}
