// Serializable shapes shared by the server page and the client queue.
// Everything crossing the RSC boundary is a plain data structure: formatted
// strings, never Dates, formatter instances or functions.
import type { ArgRow } from './format';

export type { ArgRow };

export interface PendingProposal {
  readonly id: string;
  /** Raw action name (`post_payment`, …) — the client localises it. */
  readonly action: string;
  /** Registered tool that asked for the action (`propose_payment`, …). */
  readonly toolName: string;
  readonly summary: string;
  readonly modelId: string | null;
  /** Preformatted for the active locale, plus the machine-readable ISO value. */
  readonly createdAt: string;
  readonly createdIso: string;
  readonly expiresAt: string;
  readonly expiresIso: string;
  /** `expires_at` already behind the server clock; the executor will refuse it. */
  readonly expired: boolean;
  readonly args: readonly ArgRow[];
}

export interface DecidedProposal {
  readonly id: string;
  readonly action: string;
  readonly summary: string;
  readonly status: string;
  readonly decidedAt: string;
  readonly decidedIso: string;
  readonly decidedBy: string | null;
  /** `result.error` when the executor recorded one, otherwise empty. */
  readonly note: string;
}
