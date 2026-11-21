'use client';

/**
 * The reverse button for one executed proposal.
 *
 * Three rules, taken from `lib/approvals/reverse.ts` and enforced again here so
 * an operator is never offered an action the server will refuse:
 *
 *   1. Only an execution the executor *confirmed by read-back* is reversible.
 *      The page hands us `reversible`; a false value renders nothing.
 *   2. The reason is mandatory and travels with the request. A reversal nobody
 *      can explain later is indistinguishable from a mistake being covered up.
 *   3. No optimistic UI. What the row shows after the POST is what the server
 *      said, and only a 200 re-reads the database.
 *
 * The status block shows a sentence, never the machine ids from the response:
 * this component lives in a table cell, and a raw `payment_voided …` uuid in a
 * narrow cell wraps one character per line and destroys the row height. The ids
 * are in the API response and in `proposal_reversals.effect` for anyone who
 * needs them.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@aqar/ui';
import type { Locale } from '@aqar/contracts';
import { stringsFor } from './copy';

const MIN_REASON = 10;

type Phase = 'idle' | 'confirming' | 'busy' | 'done';

interface Outcome {
  readonly ok: boolean;
  /** The sentence shown to the operator: the server's own words where it gave any. */
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOutcome(body: unknown, httpStatus: number, s: ReturnType<typeof stringsFor>): Outcome {
  if (isRecord(body)) {
    const status = typeof body['status'] === 'string' ? body['status'] : '';
    // 409 carries {"status":"refused","reason":"…"} — a refusal is a real
    // answer, not an error, and it must be shown verbatim.
    if (status === 'refused') {
      const reason = typeof body['reason'] === 'string' ? body['reason'] : s.reversalRefused;
      return { ok: false, message: reason };
    }
    if (status === 'reversed') {
      // `confirmed` is the executor's read-back, repeated for the reversal. A
      // reversal that committed but did not read back is not a success.
      if (body['confirmed'] === true) return { ok: true, message: s.reversed };
      return { ok: false, message: s.reversalUnconfirmed };
    }
    if (typeof body['error'] === 'string') return { ok: false, message: body['error'] };
  }
  return { ok: false, message: `HTTP ${httpStatus}` };
}

export function ReversalButton({
  proposalId,
  locale,
  reversible,
}: {
  proposalId: string;
  locale: Locale;
  /** `status = 'executed'` and `result.confirmed = true` and not already reversed. */
  reversible: boolean;
}) {
  const s = stringsFor(locale);
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Once a reversal has an answer, keep the answer on screen even after the
  // server refresh flips `reversible` to false — otherwise the confirmation is
  // wiped in the same tick it arrives, and the operator never sees the read-back.
  if (!reversible && outcome === null) return null;

  async function submit(): Promise<void> {
    if (reason.trim().length < MIN_REASON) return;
    setPhase('busy');
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/reversal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body: unknown = await response.json().catch(() => null);
      setOutcome(toOutcome(body, response.status, s));
      setPhase('done');
      // The database is the truth. A 200 or a 409 both mean the row moved.
      if (response.ok || response.status === 409) router.refresh();
    } catch (error) {
      setOutcome({ ok: false, message: error instanceof Error ? error.message : String(error) });
      setPhase('done');
    }
  }

  const tooShort = reason.trim().length < MIN_REASON;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      {phase === 'idle' && reversible && (
        <Button variant="danger" onClick={() => { setPhase('confirming'); }}>
          {s.reverse}
        </Button>
      )}

      {(phase === 'confirming' || phase === 'busy') && reversible && (
        <div style={{ display: 'grid', gap: 'var(--space-2)', minWidth: 220 }}>
          <label
            htmlFor={`reversal-reason-${proposalId}`}
            style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)' }}
          >
            {s.reversalReason}
          </label>
          <textarea
            id={`reversal-reason-${proposalId}`}
            value={reason}
            dir="auto"
            rows={2}
            disabled={phase === 'busy'}
            placeholder={s.reversalPlaceholder}
            onChange={(event) => { setReason(event.target.value); }}
            style={{
              font: 'inherit',
              fontSize: 'var(--text-sm)',
              padding: 'var(--space-2)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--ink)',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="danger"
              disabled={phase === 'busy' || tooShort}
              aria-busy={phase === 'busy'}
              onClick={() => { void submit(); }}
            >
              {phase === 'busy' ? s.reversing : s.reverseConfirm}
            </Button>
            <Button
              variant="secondary"
              disabled={phase === 'busy'}
              onClick={() => { setReason(''); setPhase('idle'); }}
            >
              {s.cancel}
            </Button>
            {tooShort && (
              <span style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                {s.reversalReasonShort}
              </span>
            )}
          </div>
        </div>
      )}

      {phase === 'done' && outcome !== null && (
        <div
          role="status"
          aria-live="polite"
          dir="auto"
          style={{
            background: outcome.ok ? 'var(--ok-soft)' : 'var(--danger-soft)',
            color: outcome.ok ? 'var(--ok)' : 'var(--danger)',
            border: `1px solid ${outcome.ok ? 'var(--ok)' : 'var(--danger)'}`,
            borderRadius: 'var(--radius)',
            padding: 'var(--space-2) var(--space-3)',
            fontSize: 'var(--text-sm)',
            overflowWrap: 'anywhere',
            minWidth: 220,
          }}
        >
          <strong>{outcome.ok ? s.reversedLabel : s.reversalRefusedLabel}: </strong>
          <span>{outcome.message}</span>
        </div>
      )}
    </div>
  );
}
