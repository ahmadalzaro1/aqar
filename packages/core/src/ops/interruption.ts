// The interruption policy (LAW 1: pure — no I/O, no LLM, no wall clock).
//
// A proactive agent's failure mode is not being wrong; it is being
// *unignorable*. Google SRE's doctrine is the standard here: "I can only react
// with a sense of urgency a few times a day before I become fatigued", every
// page must be actionable, and pages must be about novel problems. Apple states
// the user-facing corollary: "avoid sending multiple notifications for the same
// thing, even if someone hasn't responded".
//
// So this module answers exactly one question — *may this intent be delivered
// right now?* — with a decision the caller can log, never a boolean. A silent
// `false` teaches nobody anything; `{action:'suppress', reason:'daily_budget'}`
// is a measurement.

/** T0 safety, T1 money/legal, T2 operational, T3 ambient. */
export type NotificationTier = 0 | 1 | 2 | 3;

export type IntentStatus = 'open' | 'notified' | 'acked' | 'resolved' | 'declined' | 'expired';

export type SuppressionReason =
  | 'quiet_hours'
  | 'daily_budget'
  | 'global_budget'
  | 'max_notifications'
  | 'not_open'
  | 'ambient_only'
  | 'cooldown'
  | 'channel_disabled';

export interface TierPolicy {
  readonly tier: NotificationTier;
  readonly label: string;
  /** Safety interrupts a human at 03:00. Nothing else does. */
  readonly bypassQuietHours: boolean;
  /** Max deliveries to one human per day for this tier. null = no per-tier cap. */
  readonly dailyCapPerHuman: number | null;
  /** Human action required for the intent to close. */
  readonly requiresAck: boolean;
  /** Days during which the same dedupe key cannot re-open after a decline. */
  readonly reopenCooldownDays: number;
}

export const TIER_POLICIES: Readonly<Record<NotificationTier, TierPolicy>> = {
  0: {
    tier: 0,
    label: 'safety',
    bypassQuietHours: true,
    dailyCapPerHuman: null,
    requiresAck: true,
    reopenCooldownDays: 0,
  },
  1: {
    tier: 1,
    label: 'money_or_legal',
    bypassQuietHours: false,
    dailyCapPerHuman: 1,
    requiresAck: true,
    reopenCooldownDays: 1,
  },
  2: {
    tier: 2,
    label: 'operational',
    bypassQuietHours: false,
    dailyCapPerHuman: 1,
    requiresAck: false,
    reopenCooldownDays: 7,
  },
  3: {
    tier: 3,
    label: 'ambient',
    bypassQuietHours: false,
    dailyCapPerHuman: 0,
    requiresAck: false,
    reopenCooldownDays: 30,
  },
};

/** Hard ceiling across every tier for one human in one day. */
export const HUMAN_DAILY_CAP = 6;

/** Org-wide ceiling per day, the blast-radius stop when a scanner misfires. */
export const ORG_DAILY_CAP = 200;

/**
 * The semantic identity of an interruption.
 *
 * `rent_due:charge:<id>:-3d` fires once; a random uuid would fire on every scan.
 * The period suffix is what makes a *recurring* fact one intent per period
 * (`rent_due:charge:<id>:2026-11`) rather than one forever.
 */
export function notificationDedupeKey(parts: {
  readonly trigger: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly period?: string;
}): string {
  const base = `${parts.trigger}:${parts.entityType}:${parts.entityId}`;
  return parts.period === undefined || parts.period === '' ? base : `${base}:${parts.period}`;
}

/** True when `hour` (0–23, org-local) falls in [start, end), wrapping midnight. */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`hour must be an integer 0–23, received ${String(hour)}`);
  }
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export interface DispatchInput {
  readonly status: IntentStatus;
  readonly tier: NotificationTier;
  readonly attempts: number;
  readonly maxNotifications: number;
  /** 0–23 in the organization's timezone. Never a UTC hour. */
  readonly localHour: number;
  readonly quietStartHour: number;
  readonly quietEndHour: number;
  /** Deliveries already made to this human today, all tiers. */
  readonly humanSentToday: number;
  /** Deliveries already made to this human today for this tier. */
  readonly humanSentTodayForTier: number;
  /** Deliveries already made by this organization today, all humans. */
  readonly orgSentToday: number;
  /** A kill switch per channel, read at send time. */
  readonly channelEnabled?: boolean;
}

export type DispatchDecision =
  | { readonly action: 'send' }
  | {
      readonly action: 'defer';
      readonly reason: 'quiet_hours';
      /** Local hour at which quiet hours end. */
      readonly untilLocalHour: number;
    }
  | { readonly action: 'suppress'; readonly reason: SuppressionReason };

const SEND: DispatchDecision = { action: 'send' };
const suppress = (reason: SuppressionReason): DispatchDecision => ({ action: 'suppress', reason });

/**
 * The gate. Order matters: cheap terminal checks first, then the temporal gate,
 * then budgets. The first failing rule wins, so a suppressed intent always
 * carries the *most fundamental* reason it was suppressed.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  if (input.channelEnabled === false) return suppress('channel_disabled');
  if (input.status !== 'open' && input.status !== 'notified') return suppress('not_open');
  if (input.tier === 3) return suppress('ambient_only');
  if (input.attempts >= input.maxNotifications) return suppress('max_notifications');

  const policy = TIER_POLICIES[input.tier];

  const quiet = isQuietHour(input.localHour, input.quietStartHour, input.quietEndHour);
  if (quiet && !policy.bypassQuietHours) {
    return { action: 'defer', reason: 'quiet_hours', untilLocalHour: input.quietEndHour };
  }

  if (policy.dailyCapPerHuman !== null && input.humanSentTodayForTier >= policy.dailyCapPerHuman) {
    return suppress('daily_budget');
  }
  if (input.humanSentToday >= HUMAN_DAILY_CAP) return suppress('daily_budget');
  if (input.orgSentToday >= ORG_DAILY_CAP) return suppress('global_budget');

  return SEND;
}

/**
 * What to do with an intent that was delivered and then went unanswered.
 *
 * Silence is an answer, and it must be a terminal one: re-notifying forever is
 * how an agent gets muted. After `maxNotifications` the intent is expired and
 * surfaced in the digest as unresolved, never re-pinged.
 */
export function escalationAction(input: {
  readonly attempts: number;
  readonly maxNotifications: number;
  readonly secondsSinceLastNotice: number;
  readonly timeoutSeconds: number;
}): 'wait' | 'renotify' | 'expire' {
  if (input.attempts >= input.maxNotifications) return 'expire';
  return input.secondsSinceLastNotice >= input.timeoutSeconds ? 'renotify' : 'wait';
}

/**
 * A declined intent is a decision, not a failure. Re-opening it within the
 * cooldown asks a human the same question twice — the fastest way to lose them.
 */
export function canReopen(input: {
  readonly declinedAt: Date | null;
  readonly now: Date;
  readonly tier: NotificationTier;
}): boolean {
  if (input.declinedAt === null) return true;
  const { reopenCooldownDays } = TIER_POLICIES[input.tier];
  if (reopenCooldownDays === 0) return true;
  const elapsedDays = (input.now.getTime() - input.declinedAt.getTime()) / 86_400_000;
  return elapsedDays >= reopenCooldownDays;
}
