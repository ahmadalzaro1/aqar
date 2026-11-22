// M5/M6 — the dispatch decision layer.
//
// Three questions, answered here so the console, the agent and the tests cannot
// disagree about them:
//
//   1. Which vendors may be offered this job? (trade, allow-list, insurance in
//      force on the day of the offer)
//   2. May this work order be issued without a human? (a missing NTE is not
//      "no limit" — it is "unknown", and an unknown commitment is never
//      something a machine gets to make)
//   3. Which quote should a human read first, and what does completing the job
//      mean for the money that was authorised?
//
// Nothing here reads a clock or a database: the caller passes the instant, so a
// test can pin it and a replay produces the same answer.

import { canonicalTrade, foldTradeWord } from '../taxonomy/trade-aliases.js';

/** A vendor as the console knows it, narrowed to what a dispatch decision needs. */
export interface DispatchVendor {
  readonly id: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  /**
   * Trade vocabulary from core/taxonomy/trades. Stored as written for whoever
   * entered it, compared through `canonicalTrade` — «سباكة», "plumbing" and
   * "plumber" are the same capability, and only one of them is a token.
   */
  readonly trades: readonly string[];
  /** false means the vendor may exist in the roster but is not offered work */
  readonly allowListed: boolean;
  /** ISO date (YYYY-MM-DD) or null when the certificate is not on file */
  readonly insuranceCertExpiry: string | null;
  /** 0–5 stars from prior jobs, or null when nobody has rated them yet */
  readonly rating: number | null;
  /** vendorScore() output in [0, 100], or null for an unproven vendor */
  readonly score: number | null;
}

export interface EligibilityQuery {
  /** the trade this job needs, e.g. 'plumber' */
  readonly trade: string;
  /** ISO date of the offer — insurance is judged on this day, not on "now" */
  readonly onDate: string;
  /**
   * Other words the roster may use for this same trade. The vendor table is
   * filled by humans, so it says "plumbing" while the taxonomy says "plumber";
   * the caller derives the aliases from the taxonomy so there is still exactly
   * one table that decides what a trade is.
   */
  readonly aliases?: readonly string[];
}

function normaliseTrade(value: string): string {
  // One table decides what a trade is: `canonicalTrade` absorbs the category
  // names the roster was typed with ("plumbing"), the Arabic words a Jordanian
  // supplier writes («سباكة») and the retired VendorTrade vocabulary. The folded
  // fallback keeps an unrecognised word comparable to itself instead of throwing
  // it away — a vendor with a trade we have never seen is still a vendor.
  return canonicalTrade(value) ?? foldTradeWord(value);
}

function insuranceInForce(expiry: string | null, onDate: string): boolean {
  // No certificate on file is not a disqualification — the roster is allowed to
  // hold a vendor whose paperwork is still being collected — but it does not
  // rank above one that has it. Judging "no certificate" as expired would make
  // a brand-new vendor unofferable, which is a different decision than this one.
  if (expiry === null) return true;
  return expiry >= onDate;
}

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // unproven sorts last, never as zero
  if (b === null) return -1;
  return b - a;
}

/**
 * Vendors that may be offered this job, best first.
 *
 * Order: proven score (desc), then rating (desc), then English name (asc) so the
 * list is stable between renders and between runs — a vendor list that reshuffles
 * on every page load makes "the one at the top" meaningless.
 */
export function eligibleVendors(
  vendors: readonly DispatchVendor[],
  query: EligibilityQuery,
): DispatchVendor[] {
  const wanted = new Set([query.trade, ...(query.aliases ?? [])].map(normaliseTrade));
  return vendors
    .filter((v) => v.allowListed)
    .filter((v) => v.trades.some((t) => wanted.has(normaliseTrade(t))))
    .filter((v) => insuranceInForce(v.insuranceCertExpiry, query.onDate))
    .sort(
      (a, b) =>
        compareNullableDesc(a.score, b.score) ||
        compareNullableDesc(a.rating, b.rating) ||
        a.nameEn.localeCompare(b.nameEn),
    );
}

export type ApprovalReason = 'within_limit' | 'over_limit' | 'no_nte';

export interface ApprovalDecision {
  readonly requiresApproval: boolean;
  readonly reason: ApprovalReason;
}

/**
 * Whether issuing this work order needs a human signature.
 *
 * An absent NTE requires approval: authorising work with no ceiling is not a
 * smaller decision than authorising a capped one, it is a larger one. A zero
 * limit is a real limit ("do not spend"), so it is judged, not special-cased.
 */
export function approvalForNte(input: {
  readonly nteFils: number | null;
  readonly approvalLimitFils: number;
}): ApprovalDecision {
  if (input.nteFils === null) return { requiresApproval: true, reason: 'no_nte' };
  if (!Number.isInteger(input.nteFils) || input.nteFils < 0) {
    throw new Error(`NTE must be a non-negative integer number of fils, got ${input.nteFils}`);
  }
  return input.nteFils > input.approvalLimitFils
    ? { requiresApproval: true, reason: 'over_limit' }
    : { requiresApproval: false, reason: 'within_limit' };
}

export interface QuoteForRanking {
  readonly id: string;
  readonly vendorId: string;
  readonly amountFils: number;
  /** vendor's stated lead time, null when they did not say */
  readonly leadTimeDays: number | null;
  /** ISO instant the quote arrived */
  readonly receivedAt: string;
}

/**
 * Quotes in the order a human should read them: cheapest first, then fastest,
 * then earliest received, then by id so the order is total.
 *
 * Cheapest-first is a reading order, not a decision: selecting a quote stays a
 * human act (see `quoteSelectionIsValid`).
 */
export function rankQuotes(quotes: readonly QuoteForRanking[]): QuoteForRanking[] {
  return [...quotes].sort((a, b) => {
    if (a.amountFils !== b.amountFils) return a.amountFils - b.amountFils;
    const lead = compareNullableDesc(
      a.leadTimeDays === null ? null : -a.leadTimeDays,
      b.leadTimeDays === null ? null : -b.leadTimeDays,
    );
    if (lead !== 0) return lead;
    if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/** Exactly zero or one quote may be selected: two accepted prices is not a state. */
export function quoteSelectionIsValid(quotes: readonly { readonly selected: boolean }[]): boolean {
  return quotes.filter((q) => q.selected).length <= 1;
}

export interface CompletionOutcome {
  /** what the vendor actually charged, minus what was authorised (may be negative) */
  readonly varianceFils: number;
  /**
   * True when the invoice exceeds the authorised ceiling. This is not an error:
   * it is the case the product must show a human, because someone has to accept
   * the overage before it becomes a payable.
   */
  readonly overNte: boolean;
}

/** What completing the job means for the money that was authorised. */
export function completionOutcome(input: {
  readonly costFils: number;
  readonly nteFils: number | null;
}): CompletionOutcome {
  if (!Number.isInteger(input.costFils) || input.costFils < 0) {
    throw new Error(`cost must be a non-negative integer number of fils, got ${input.costFils}`);
  }
  if (input.nteFils === null) {
    return { varianceFils: input.costFils, overNte: true };
  }
  return {
    varianceFils: input.costFils - input.nteFils,
    overNte: input.costFils > input.nteFils,
  };
}
