/**
 * The argument contract for the actions the executor can actually perform.
 *
 * Why this exists: the propose path accepts whatever an agent or a form hands it,
 * so a proposal can be filed with arguments the database will refuse — a cheque
 * with no status, say. Without a validator the operator only finds out after
 * approving it, as a constraint violation, and the queue keeps a row that can
 * never succeed.
 *
 * These are the rules the schema cannot express on its own:
 *   - `payments_cheque_status_ck` pairs `cheque_status` with `method`, so the
 *     presence of the field depends on another field, not on the row alone;
 *   - money is integer fils, so a fractional amount is a lie before it is a bug.
 *
 * Pure and I/O-free: the proposer calls it to refuse a bad draft, and the
 * executor calls it again to refuse a bad legacy row.
 */

/** Must match the `payment_method` Postgres enum. */
export const PAYMENT_METHODS = ['cash', 'cliq', 'bank_transfer', 'cheque'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Must match the `cheque_status` Postgres enum. */
export const CHEQUE_STATUSES = ['received', 'deposited', 'cleared', 'bounced'] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

const isPaymentMethod = (v: unknown): v is PaymentMethod =>
  typeof v === 'string' && (PAYMENT_METHODS as readonly string[]).includes(v);

const isChequeStatus = (v: unknown): v is ChequeStatus =>
  typeof v === 'string' && (CHEQUE_STATUSES as readonly string[]).includes(v);

/**
 * Problems with the arguments for one action. An empty array means the executor's
 * handler can run; anything else is a refusal that names the field.
 */
export function validateActionArgs(action: string, args: Record<string, unknown>): readonly string[] {
  const problems: string[] = [];

  if (action === 'post_payment') {
    const method = args['method'];
    if (!isPaymentMethod(method)) {
      problems.push(`"method" must be one of ${PAYMENT_METHODS.join(', ')} (got ${JSON.stringify(method ?? null)})`);
    }

    const amount = args['amountFils'];
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      problems.push(`"amountFils" must be a positive integer number of fils (got ${JSON.stringify(amount ?? null)})`);
    }

    const chequeStatus = args['chequeStatus'];
    if (method === 'cheque') {
      if (!isChequeStatus(chequeStatus)) {
        problems.push(`a cheque payment needs "chequeStatus" to be one of ${CHEQUE_STATUSES.join(', ')} (got ${JSON.stringify(chequeStatus ?? null)})`);
      }
    } else if (chequeStatus !== undefined && chequeStatus !== null) {
      problems.push(`"chequeStatus" was supplied for a ${String(method)} payment, which cannot carry one`);
    }

    if (typeof args['receivedDate'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args['receivedDate'])) {
      problems.push('"receivedDate" must be a YYYY-MM-DD date');
    }

    // Allocations are an optional list of {chargeId, amountFils}. Checking them
    // here means a payment cannot be filed that would over-apply money to charges
    // — the handler refuses it, but only after a human has already signed.
    const allocations = args['allocations'];
    if (allocations !== undefined && allocations !== null) {
      if (!Array.isArray(allocations)) {
        problems.push('"allocations" must be an array of {chargeId, amountFils}');
      } else {
        let total = 0;
        allocations.forEach((entry, index) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            problems.push(`allocations[${index}] must be an object`);
            return;
          }
          const row = entry as Record<string, unknown>;
          if (typeof row['chargeId'] !== 'string' || row['chargeId'].length === 0) {
            problems.push(`allocations[${index}].chargeId must be a non-empty string`);
          }
          const part = row['amountFils'];
          if (typeof part !== 'number' || !Number.isInteger(part) || part <= 0) {
            problems.push(`allocations[${index}].amountFils must be a positive integer number of fils`);
            return;
          }
          total += part;
        });
        if (typeof amount === 'number' && Number.isInteger(amount) && total > amount) {
          problems.push(`allocations total ${total} fils exceeds the payment amount ${amount} fils`);
        }
      }
    }
  }

  if (action === 'dispatch_vendor') {
    const ticketId = args['ticketId'];
    if (typeof ticketId !== 'string' || ticketId.length === 0) {
      problems.push('"ticketId" must be a non-empty string');
    }
    const vendorId = args['vendorId'];
    if (typeof vendorId !== 'string' || vendorId.length === 0) {
      problems.push('"vendorId" must be a non-empty string');
    }
    // `amountFils` is the not-to-exceed figure and is optional, but a present one
    // must be a real amount: a work order with a fractional NTE is a typo the
    // vendor will invoice against.
    const nte = args['amountFils'];
    if (nte !== undefined && nte !== null) {
      if (typeof nte !== 'number' || !Number.isInteger(nte) || nte <= 0) {
        problems.push(`"amountFils" must be a positive integer number of fils when present (got ${JSON.stringify(nte)})`);
      }
    }
  }

  return problems;
}

/** One line, for a queue row or a refusal message. */
export function describeArgProblems(problems: readonly string[]): string {
  return problems.length === 0 ? '' : problems.join('; ');
}
