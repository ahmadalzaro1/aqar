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
  }

  return problems;
}

/** One line, for a queue row or a refusal message. */
export function describeArgProblems(problems: readonly string[]): string {
  return problems.length === 0 ? '' : problems.join('; ');
}
