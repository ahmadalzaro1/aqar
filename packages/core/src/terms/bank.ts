import type { BankLine, Charge, MatchSuggestion } from '@aqar/contracts';
import {
  assertNonNegativeInteger,
  fnv1a32Hex,
  normalizeArabicText,
  parseIsoDate,
  toEpochDay,
} from './internal.js';

/**
 * A payer as the reconciliation engine knows it. Names are the variants seen
 * on bank statements ("محمد علي", "MOHAMMED ALI"); accounts are the bank
 * account identifiers that unambiguously belong to this payer.
 */
export interface PayerProfile {
  readonly payerId: string;
  readonly leaseId: string;
  readonly names: readonly string[];
  readonly accounts: readonly string[];
  /** A human has verified this payer <-> lease <-> account relationship. */
  readonly confirmed: boolean;
}

export type ChargesByLease = Readonly<Record<string, readonly Charge[]>>;

const FIELD_SEPARATOR = '|';

function normalizeAccountKey(account: string): string {
  return normalizeArabicText(account).replace(/[\s-]/g, '');
}

/**
 * Deterministic fingerprint of a bank line over `date|amount|payerName`,
 * normalized (lowercase, collapsed whitespace, Arabic-Indic digits to ASCII,
 * diacritics and tatweel stripped, alef variants folded).
 *
 * Reference and payer account are DELIBERATELY EXCLUDED (frozen spec): tenants
 * type junk in references, and the same payer appears with different account
 * spellings across banks. Overlapping statements therefore produce the same
 * fingerprint for the same real movement. Known trade-off: two distinct
 * same-day same-amount payments from one payer collide; the import wizard
 * surfaces duplicates for human review rather than silently dropping them.
 */
export function fingerprintBankLine(line: BankLine): string {
  const normalized = [
    normalizeArabicText(line.dateISO),
    String(line.amountFils),
    normalizeArabicText(line.payerName),
  ].join(FIELD_SEPARATOR);
  return fnv1a32Hex(normalized);
}

/**
 * Incoming lines whose fingerprint is absent from `existing` AND absent from
 * earlier incoming lines. Idempotent: re-running it on its own output yields
 * nothing.
 */
export function dedupeBankLines(
  existing: readonly BankLine[],
  incoming: readonly BankLine[],
): BankLine[] {
  const seen = new Set<string>();
  for (const line of existing) {
    seen.add(fingerprintBankLine(line));
  }
  const fresh: BankLine[] = [];
  for (const line of incoming) {
    const fingerprint = fingerprintBankLine(line);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    fresh.push(line);
  }
  return fresh;
}

interface Candidate {
  readonly profile: PayerProfile;
  readonly leaseId: string;
  readonly charges: readonly Charge[];
  readonly outstandingFils: number;
  readonly exactChargeIds: readonly string[];
  readonly nearestDays: number | null;
  readonly matchedByName: boolean;
  readonly matchedByAccount: boolean;
  readonly score: number;
}

function sortCharges(charges: readonly Charge[]): Charge[] {
  return [...charges].sort((a, b) => {
    if (a.dueDateISO !== b.dueDateISO) {
      return a.dueDateISO < b.dueDateISO ? -1 : 1;
    }
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return 0;
  });
}

function sumChargeAmounts(charges: readonly Charge[]): number {
  let total = 0;
  for (const charge of charges) {
    if (!Number.isSafeInteger(charge.amountFils) || charge.amountFils < 0) {
      throw new RangeError(`charge ${charge.id} has an invalid amountFils`);
    }
    total += charge.amountFils;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('outstanding total exceeds the safe integer range');
    }
  }
  return total;
}

function describeFils(fils: number): string {
  return `${String(fils)} fils`;
}

function matchedByText(candidate: Candidate): string {
  if (candidate.matchedByAccount && candidate.matchedByName) {
    return 'payer name and bank account';
  }
  return candidate.matchedByAccount ? 'bank account' : 'payer name';
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Oldest-first proposed allocation of a partial payment: walk the lease's open
 * charges by due date and take as much as each can absorb.
 */
export function proposeOldestFirstAllocation(
  charges: readonly Charge[],
  amountFils: number,
): Array<{ readonly chargeId: string; readonly amountFils: number }> {
  let remaining = amountFils;
  const plan: Array<{ readonly chargeId: string; readonly amountFils: number }> = [];
  for (const charge of sortCharges(charges)) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(remaining, charge.amountFils);
    if (take <= 0) {
      continue;
    }
    plan.push({ chargeId: charge.id, amountFils: take });
    remaining -= take;
  }
  return plan;
}

/**
 * Suggest how to post one bank line against known leases.
 *
 * Matching uses PAYER IDENTITY (normalized name or bank account), AMOUNT and a
 * DATE TOLERANCE — never the transfer reference, because tenants type junk in
 * references. Decision rules, in order:
 *
 * - no payer identity matches            -> `unknown_payer`
 * - two or more payer/lease candidates can absorb the same amount -> `ambiguous`
 * - known payer and amount < outstanding -> `partial`, oldest-first proposal
 * - confirmed payer and amount == total outstanding -> `auto` (0.95)
 * - everything else (unconfirmed payer, overpayment, no matching charge) -> `review`
 *
 * `reason` is always a nonempty human-readable explanation.
 */
export function suggestMatch(
  line: BankLine,
  payers: readonly PayerProfile[],
  chargesByLease: ChargesByLease,
  dateToleranceDays = 5,
): MatchSuggestion {
  const lineISO = parseIsoDate(line.dateISO, 'line.dateISO');
  const tolerance = assertNonNegativeInteger(dateToleranceDays, 'dateToleranceDays');
  const amount = assertNonNegativeInteger(line.amountFils, 'line.amountFils');
  const lineName = normalizeArabicText(line.payerName);
  const lineAccount = normalizeAccountKey(line.payerAccount ?? '');
  const lineEpoch = toEpochDay(lineISO);

  const byPayerLease = new Map<string, Candidate>();
  for (const profile of payers) {
    const matchedByName =
      lineName.length > 0 && profile.names.some((name) => normalizeArabicText(name) === lineName);
    const matchedByAccount =
      lineAccount.length > 0 &&
      profile.accounts.some((account) => normalizeAccountKey(account) === lineAccount);
    if (!matchedByName && !matchedByAccount) {
      continue;
    }
    const leaseCharges = sortCharges(chargesByLease[profile.leaseId] ?? []);
    const outstanding = sumChargeAmounts(leaseCharges);
    const exactChargeIds: string[] = [];
    let nearestDays: number | null = null;
    for (const charge of leaseCharges) {
      const dueEpoch = toEpochDay(parseIsoDate(charge.dueDateISO, 'charge.dueDateISO'));
      const distance = Math.abs(dueEpoch - lineEpoch);
      if (nearestDays === null || distance < nearestDays) {
        nearestDays = distance;
      }
      if (charge.amountFils === amount && distance <= tolerance) {
        exactChargeIds.push(charge.id);
      }
    }

    let score = 0;
    if (exactChargeIds.length > 0) {
      score += 1000;
    }
    if (amount > 0 && outstanding === amount) {
      score += 600;
    }
    if (matchedByAccount) {
      score += 100;
    }
    if (matchedByName) {
      score += 60;
    }
    if (profile.confirmed) {
      score += 40;
    }
    if (nearestDays !== null && nearestDays <= tolerance) {
      score += tolerance - nearestDays + 1;
    }

    const key = `${profile.payerId}\u0000${profile.leaseId}`;
    const previous = byPayerLease.get(key);
    if (previous !== undefined && previous.score >= score) {
      continue;
    }
    byPayerLease.set(key, {
      profile,
      leaseId: profile.leaseId,
      charges: leaseCharges,
      outstandingFils: outstanding,
      exactChargeIds,
      nearestDays,
      matchedByName,
      matchedByAccount,
      score,
    });
  }

  const candidates = [...byPayerLease.values()];
  candidates.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.leaseId !== b.leaseId) {
      return a.leaseId < b.leaseId ? -1 : 1;
    }
    if (a.profile.payerId !== b.profile.payerId) {
      return a.profile.payerId < b.profile.payerId ? -1 : 1;
    }
    return 0;
  });

  const best = candidates[0];
  if (best === undefined) {
    return {
      bankLineId: line.id,
      kind: 'unknown_payer',
      leaseIds: [],
      payerId: null,
      amountFils: amount,
      confidence: 0.1,
      reason: `No known payer matches "${line.payerName}"${
        lineAccount.length > 0 ? ` or account ${line.payerAccount ?? ''}` : ''
      } on ${lineISO} for ${describeFils(amount)}; link the payer to a lease before posting.`,
    };
  }

  const plausible = candidates.filter(
    (candidate) =>
      candidate.exactChargeIds.length > 0 || (amount > 0 && candidate.outstandingFils === amount),
  );

  if (plausible.length >= 2) {
    const leaseIds = uniqueInOrder(plausible.map((candidate) => candidate.leaseId));
    const detail = plausible
      .slice(0, 5)
      .map(
        (candidate) =>
          `payer ${candidate.profile.payerId} / lease ${candidate.leaseId}${
            candidate.profile.confirmed ? ' (confirmed)' : ' (unconfirmed)'
          }`,
      )
      .join('; ');
    return {
      bankLineId: line.id,
      kind: 'ambiguous',
      leaseIds,
      payerId: null,
      amountFils: amount,
      confidence: 0.5,
      reason: `Ambiguous payment: ${String(
        plausible.length,
      )} known payer/lease candidates could absorb ${describeFils(amount)} on ${lineISO}: ${detail}. A human must pick the lease.`,
    };
  }

  const target = plausible[0] ?? best;

  if (amount < target.outstandingFils) {
    const plan = proposeOldestFirstAllocation(target.charges, amount);
    const planText =
      plan.length === 0
        ? 'no open charge can absorb it'
        : plan
            .map((entry) => `charge ${entry.chargeId} <- ${describeFils(entry.amountFils)}`)
            .join('; ');
    return {
      bankLineId: line.id,
      kind: 'partial',
      leaseIds: [target.leaseId],
      payerId: target.profile.payerId,
      amountFils: amount,
      confidence: target.profile.confirmed ? 0.8 : 0.6,
      reason: `Payer ${target.profile.payerId}${
        target.profile.confirmed ? ' (confirmed)' : ' (unconfirmed)'
      } paid ${describeFils(amount)}, below the ${describeFils(
        target.outstandingFils,
      )} outstanding on lease ${target.leaseId}; propose oldest-first allocation: ${planText}.`,
    };
  }

  if (target.profile.confirmed && amount > 0 && target.outstandingFils === amount) {
    return {
      bankLineId: line.id,
      kind: 'auto',
      leaseIds: [target.leaseId],
      payerId: target.profile.payerId,
      amountFils: amount,
      confidence: 0.95,
      reason: `Confirmed payer ${target.profile.payerId} matched by ${matchedByText(
        target,
      )} paid exactly ${describeFils(amount)}, covering the outstanding balance of lease ${
        target.leaseId
      }; safe to auto-post.`,
    };
  }

  const overpayment = amount - target.outstandingFils;
  const deltaText =
    overpayment > 0
      ? `overpays by ${describeFils(overpayment)}`
      : target.outstandingFils === 0
        ? 'has no open charge on the lease'
        : `does not match an open charge (${describeFils(target.outstandingFils)} outstanding)`;
  return {
    bankLineId: line.id,
    kind: 'review',
    leaseIds: [target.leaseId],
    payerId: target.profile.payerId,
    amountFils: amount,
    confidence: target.profile.confirmed ? 0.7 : 0.5,
    reason: `Payer ${target.profile.payerId} matched by ${matchedByText(target)} is ${
      target.profile.confirmed ? 'confirmed' : 'unconfirmed'
    }; a payment of ${describeFils(amount)} on ${lineISO} ${deltaText} for lease ${
      target.leaseId
    }, so it needs review before posting.`,
  };
}
