import { describe, expect, it } from 'vitest';
import {
  HUMAN_DAILY_CAP,
  ORG_DAILY_CAP,
  TIER_POLICIES,
  canReopen,
  decideDispatch,
  escalationAction,
  isQuietHour,
  notificationDedupeKey,
  type DispatchInput,
  type NotificationTier,
} from './interruption.js';

const base: DispatchInput = {
  status: 'open',
  tier: 2,
  attempts: 0,
  maxNotifications: 3,
  localHour: 9,
  quietStartHour: 22,
  quietEndHour: 7,
  humanSentToday: 0,
  humanSentTodayForTier: 0,
  orgSentToday: 0,
};

describe('notificationDedupeKey', () => {
  it('is stable for the same fact, so a re-scan cannot re-notify', () => {
    const key = notificationDedupeKey({
      trigger: 'rent_due',
      entityType: 'charge',
      entityId: 'c1',
    });
    expect(key).toBe('rent_due:charge:c1');
    expect(
      notificationDedupeKey({ trigger: 'rent_due', entityType: 'charge', entityId: 'c1' }),
    ).toBe(key);
  });

  it('separates periods, so a monthly charge notifies once per month not once forever', () => {
    const a = notificationDedupeKey({
      trigger: 'rent_due',
      entityType: 'charge',
      entityId: 'c1',
      period: '2026-11',
    });
    const b = notificationDedupeKey({
      trigger: 'rent_due',
      entityType: 'charge',
      entityId: 'c1',
      period: '2026-12',
    });
    expect(a).not.toBe(b);
  });

  it('ignores an empty period rather than emitting a trailing colon', () => {
    expect(
      notificationDedupeKey({ trigger: 't', entityType: 'e', entityId: 'i', period: '' }),
    ).toBe('t:e:i');
  });

  it('separates triggers on the same entity', () => {
    expect(
      notificationDedupeKey({ trigger: 'rent_due_soon', entityType: 'charge', entityId: 'c1' }),
    ).not.toBe(
      notificationDedupeKey({ trigger: 'rent_overdue', entityType: 'charge', entityId: 'c1' }),
    );
  });
});

describe('isQuietHour', () => {
  it('treats a wrapping window as quiet on both sides of midnight', () => {
    expect(isQuietHour(23, 22, 7)).toBe(true);
    expect(isQuietHour(3, 22, 7)).toBe(true);
    expect(isQuietHour(6, 22, 7)).toBe(true);
  });

  it('does not treat the hours outside a wrapping window as quiet', () => {
    expect(isQuietHour(7, 22, 7)).toBe(false);
    expect(isQuietHour(12, 22, 7)).toBe(false);
    expect(isQuietHour(21, 22, 7)).toBe(false);
  });

  it('handles a non-wrapping window', () => {
    expect(isQuietHour(13, 12, 14)).toBe(true);
    expect(isQuietHour(14, 12, 14)).toBe(false);
  });

  it('treats start === end as no quiet period at all', () => {
    expect(isQuietHour(3, 0, 0)).toBe(false);
  });

  it('rejects an impossible hour instead of silently comparing it', () => {
    expect(() => isQuietHour(24, 22, 7)).toThrow(RangeError);
    expect(() => isQuietHour(1.5, 22, 7)).toThrow(RangeError);
  });
});

describe('decideDispatch', () => {
  it('sends an ordinary operational notice in working hours', () => {
    expect(decideDispatch(base)).toEqual({ action: 'send' });
  });

  it('defers an operational notice during quiet hours, and names the resume hour', () => {
    expect(decideDispatch({ ...base, localHour: 2 })).toEqual({
      action: 'defer',
      reason: 'quiet_hours',
      untilLocalHour: 7,
    });
  });

  it('never defers a safety notice, at any hour — T0 bypasses quiet hours', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(decideDispatch({ ...base, tier: 0, localHour: hour })).toEqual({ action: 'send' });
    }
  });

  it('never sends an ambient notice at all', () => {
    expect(decideDispatch({ ...base, tier: 3 })).toEqual({
      action: 'suppress',
      reason: 'ambient_only',
    });
  });

  it('refuses to notify about a ticket somebody already acknowledged', () => {
    for (const status of ['acked', 'resolved', 'declined', 'expired'] as const) {
      expect(decideDispatch({ ...base, status })).toEqual({
        action: 'suppress',
        reason: 'not_open',
      });
    }
  });

  it('stops after maxNotifications so an unanswered intent cannot ping forever', () => {
    expect(decideDispatch({ ...base, attempts: 3, maxNotifications: 3 })).toEqual({
      action: 'suppress',
      reason: 'max_notifications',
    });
  });

  it('honours the per-tier daily cap: a second T1 to the same human is suppressed', () => {
    expect(decideDispatch({ ...base, tier: 1, humanSentTodayForTier: 1 })).toEqual({
      action: 'suppress',
      reason: 'daily_budget',
    });
  });

  it('does not let a leftover per-tier count block a safety notice', () => {
    expect(
      decideDispatch({ ...base, tier: 0, humanSentTodayForTier: 9, humanSentToday: 2 }),
    ).toEqual({
      action: 'send',
    });
  });

  it('applies the human cap across tiers', () => {
    expect(decideDispatch({ ...base, humanSentToday: HUMAN_DAILY_CAP })).toEqual({
      action: 'suppress',
      reason: 'daily_budget',
    });
  });

  it('applies the org cap as the blast-radius stop when a scanner misfires', () => {
    expect(decideDispatch({ ...base, orgSentToday: ORG_DAILY_CAP })).toEqual({
      action: 'suppress',
      reason: 'global_budget',
    });
  });

  it('reads a channel kill switch at send time', () => {
    expect(decideDispatch({ ...base, channelEnabled: false })).toEqual({
      action: 'suppress',
      reason: 'channel_disabled',
    });
  });

  it('reports the most fundamental reason when several rules fail', () => {
    // Acknowledged AND over budget AND after hours: the state is the real answer.
    expect(
      decideDispatch({ ...base, status: 'acked', localHour: 2, humanSentTodayForTier: 5 }),
    ).toEqual({ action: 'suppress', reason: 'not_open' });
  });
});

describe('decideDispatch invariants (exhaustive over the finite input space)', () => {
  const tiers: NotificationTier[] = [0, 1, 2, 3];
  const statuses = ['open', 'notified', 'acked', 'resolved', 'declined', 'expired'] as const;

  it('never sends while a hard gate is violated, for any combination of inputs', () => {
    for (const tier of tiers) {
      for (const status of statuses) {
        for (let localHour = 0; localHour < 24; localHour += 1) {
          for (const forTier of [0, 1, 2]) {
            for (const attempts of [0, 1, 3]) {
              const decision = decideDispatch({
                ...base,
                tier,
                status,
                localHour,
                attempts,
                humanSentTodayForTier: forTier,
              });
              if (decision.action !== 'send') continue;

              const policy = TIER_POLICIES[tier];
              const quiet = isQuietHour(localHour, base.quietStartHour, base.quietEndHour);
              expect(quiet && !policy.bypassQuietHours).toBe(false);
              expect(tier).not.toBe(3);
              expect(status === 'open' || status === 'notified').toBe(true);
              expect(attempts).toBeLessThan(base.maxNotifications);
              if (policy.dailyCapPerHuman !== null) {
                expect(forTier).toBeLessThan(policy.dailyCapPerHuman);
              }
            }
          }
        }
      }
    }
  });

  it('is monotonic: more prior deliveries for a tier can never restore permission to send', () => {
    for (const tier of tiers) {
      for (let localHour = 0; localHour < 24; localHour += 1) {
        let previouslySent = false;
        for (const forTier of [0, 1, 2, 3]) {
          const decision = decideDispatch({
            ...base,
            tier,
            localHour,
            humanSentTodayForTier: forTier,
          });
          if (previouslySent) expect(decision.action).not.toBe('send');
          if (decision.action !== 'send') previouslySent = true;
        }
      }
    }
  });
});

describe('escalationAction', () => {
  it('waits inside the timeout window', () => {
    expect(
      escalationAction({
        attempts: 1,
        maxNotifications: 3,
        secondsSinceLastNotice: 10,
        timeoutSeconds: 900,
      }),
    ).toBe('wait');
  });

  it('re-notifies once the window elapses', () => {
    expect(
      escalationAction({
        attempts: 1,
        maxNotifications: 3,
        secondsSinceLastNotice: 901,
        timeoutSeconds: 900,
      }),
    ).toBe('renotify');
  });

  it('expires instead of re-notifying after the attempt budget', () => {
    expect(
      escalationAction({
        attempts: 3,
        maxNotifications: 3,
        secondsSinceLastNotice: 9999,
        timeoutSeconds: 900,
      }),
    ).toBe('expire');
  });
});

describe('canReopen', () => {
  const now = new Date('2026-11-20T09:00:00Z');

  it('reopens freely when the intent was never declined', () => {
    expect(canReopen({ declinedAt: null, now, tier: 2 })).toBe(true);
  });

  it('blocks a re-open inside the operational cooldown', () => {
    expect(canReopen({ declinedAt: new Date('2026-11-18T09:00:00Z'), now, tier: 2 })).toBe(false);
  });

  it('allows a re-open after the cooldown measured in real days', () => {
    expect(canReopen({ declinedAt: new Date('2026-11-12T09:00:00Z'), now, tier: 2 })).toBe(true);
  });

  it('never blocks a safety re-open', () => {
    expect(canReopen({ declinedAt: new Date('2026-11-20T08:59:00Z'), now, tier: 0 })).toBe(true);
  });
});
