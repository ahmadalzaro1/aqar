'use client';

/**
 * The approve/reject buttons for the proposal inbox.
 *
 * No optimistic UI: a decision is a POST to the same endpoint the MCP gate and
 * the console use, and what the row shows afterwards is what the server said.
 * A 200 means the executor ran (or refused); anything else is surfaced verbatim.
 */
import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card } from '@aqar/ui';
import type { Locale } from '@aqar/contracts';
import { stringsFor, type Strings } from './copy';
import { argLabel, valueText } from './format';
import type { PendingProposal } from './types';

type Decision = 'approve' | 'reject';

interface ResultLine {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

interface Outcome {
  readonly kind: 'executed' | 'failed' | 'rejected' | 'expired' | 'error';
  /** Server-provided reason/error text; empty when the kind says it all. */
  readonly message: string;
  readonly result: readonly ResultLine[];
  /** Kept here so the row can still be summarised after `router.refresh()` drops it. */
  readonly summary: string;
  readonly action: string;
}

interface InFlight {
  readonly id: string;
  readonly decision: Decision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOutcome(body: unknown, httpStatus: number, proposal: PendingProposal, locale: Locale): Outcome {
  if (httpStatus === 200 && isRecord(body)) {
    const status = typeof body['status'] === 'string' ? body['status'] : '';
    if (status === 'executed') {
      const raw = isRecord(body['result']) ? body['result'] : {};
      const result = Object.entries(raw).map(([key, valueValue]) => ({
        key,
        label: argLabel(key, locale),
        value: valueText(key, valueValue, locale),
      }));
      return { kind: 'executed', message: '', result, summary: proposal.summary, action: proposal.action };
    }
    if (status === 'failed') {
      const reason = typeof body['reason'] === 'string' && body['reason'] !== ''
        ? body['reason']
        : 'executor reported failure without a reason';
      return { kind: 'failed', message: reason, result: [], summary: proposal.summary, action: proposal.action };
    }
    if (status === 'rejected' || status === 'expired') {
      return { kind: status, message: '', result: [], summary: proposal.summary, action: proposal.action };
    }
  }
  const message = isRecord(body) && typeof body['error'] === 'string'
    ? body['error']
    : `HTTP ${httpStatus}`;
  return { kind: 'error', message, result: [], summary: proposal.summary, action: proposal.action };
}

function OutcomeBlock({ outcome, s }: { outcome: Outcome; s: Strings }) {
  const failed = outcome.kind === 'failed' || outcome.kind === 'error';
  const ok = outcome.kind === 'executed';
  const heading = ok
    ? s.result
    : outcome.kind === 'failed'
      ? s.reason
      : outcome.kind === 'error'
        ? s.errorLabel
        : s.outcome;
  const statusText = outcome.kind === 'error' ? s.errorLabel : s.statuses[outcome.kind] ?? outcome.kind;
  return (
    <div
      role="status"
      aria-live="polite"
      dir="auto"
      style={{
        marginBlockStart: 'var(--space-3)',
        background: failed ? 'var(--danger-soft)' : ok ? 'var(--ok-soft)' : 'var(--surface-3)',
        color: failed ? 'var(--danger)' : ok ? 'var(--ok)' : 'var(--muted)',
        border: `1px solid ${failed ? 'var(--danger)' : ok ? 'var(--ok)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        padding: 'var(--space-2) var(--space-3)',
        fontSize: 'var(--text-sm)',
      }}
    >
      <strong>{heading}: </strong>
      <span>{statusText}</span>
      {outcome.message !== '' && (
        <div style={{ marginBlockStart: 4 }} dir="auto">{outcome.message}</div>
      )}
      {outcome.result.length > 0 && (
        <dl style={{
          display: 'grid', gridTemplateColumns: 'minmax(96px, max-content) minmax(0, 1fr)',
          gap: '2px var(--space-3)', margin: 0, marginBlockStart: 4,
        }}>
          {outcome.result.map((line) => (
            <Fragment key={line.key}>
              <dt style={{ opacity: 0.8 }}>{line.label}</dt>
              {/*
                The <dd> stays in the document's direction so every value shares one
                column edge; only the text inside it is bidi-isolated. Putting
                dir="auto" on the <dd> itself made Latin values left-align and Arabic
                values right-align, which read as a ragged column.
              */}
              <dd style={{ margin: 0, fontWeight: 600 }}>
                <span dir="auto" style={{ unicodeBidi: 'plaintext', overflowWrap: 'anywhere' }}>{line.value}</span>
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

export function ProposalQueue({
  proposals,
  locale,
  canDecide,
}: {
  proposals: readonly PendingProposal[];
  locale: Locale;
  canDecide: boolean;
}) {
  const s = stringsFor(locale);
  const router = useRouter();
  const [inFlight, setInFlight] = useState<InFlight | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  async function decide(proposal: PendingProposal, decision: Decision): Promise<void> {
    if (inFlight !== null) return;
    setInFlight({ id: proposal.id, decision });
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const body: unknown = await response.json().catch(() => null);
      const outcome = toOutcome(body, response.status, proposal, locale);
      setOutcomes((prev) => ({ ...prev, [proposal.id]: outcome }));
      // The database is the truth: only a real 200 re-reads it. A 409 means the
      // row moved under us, so refresh too — the queue must stop showing it.
      if (response.ok) router.refresh();
      else if (response.status === 409) router.refresh();
    } catch (error) {
      setOutcomes((prev) => ({
        ...prev,
        [proposal.id]: {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          result: [],
          summary: proposal.summary,
          action: proposal.action,
        },
      }));
    } finally {
      setInFlight(null);
    }
  }

  const pendingIds = new Set(proposals.map((proposal) => proposal.id));
  const justDecided = Object.entries(outcomes).filter(([id]) => !pendingIds.has(id));

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {proposals.map((proposal) => {
        const busy = inFlight?.id === proposal.id;
        const outcome = outcomes[proposal.id];
        return (
          <Card key={proposal.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Badge tone="accent">{s.actions[proposal.action] ?? proposal.action}</Badge>
              <code style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }} dir="ltr">{proposal.toolName}</code>
              {proposal.expired && <Badge tone="warn">{s.pastExpiry}</Badge>}
              {proposal.signatures > 0 && (
                <Badge tone="warn">{s.signaturesOf(proposal.signatures, proposal.requiredSignatures)}</Badge>
              )}
              <span
                className="tnum"
                style={{ marginInlineStart: 'auto', color: 'var(--muted)', fontSize: 'var(--text-xs)' }}
                title={`${proposal.createdIso} → ${proposal.expiresIso}`}
              >
                {s.created} {proposal.createdAt} · {s.expires} {proposal.expiresAt}
              </span>
            </div>

            <p style={{ fontWeight: 600, marginBlock: 'var(--space-2)' }} dir="auto">{proposal.summary}</p>

            {proposal.args.length > 0 && (
              <dl style={{
                display: 'grid', gridTemplateColumns: 'minmax(96px, max-content) minmax(0, 1fr)',
                gap: '2px var(--space-3)', margin: 0, fontSize: 'var(--text-sm)',
              }}>
                {proposal.args.map((arg) => (
                  <Fragment key={arg.key}>
                    <dt style={{ color: 'var(--muted)' }}>{arg.label}</dt>
                    <dd style={{ margin: 0 }}>
                      <span dir="auto" style={{ unicodeBidi: 'plaintext', overflowWrap: 'anywhere' }}>{arg.value}</span>
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}

            <div style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap',
              marginBlockStart: 'var(--space-3)', paddingBlockStart: 'var(--space-3)',
              borderBlockStart: '1px solid var(--border)',
            }}>
              <span style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>
                {s.model}: <code dir="ltr">{proposal.modelId ?? '—'}</code>
              </span>
              {outcome === undefined ? (
                <div style={{ display: 'flex', gap: 'var(--space-2)', marginInlineStart: 'auto' }}>
                  <Button
                    variant="primary"
                    disabled={busy}
                    aria-busy={busy && inFlight?.decision === 'approve'}
                    onClick={() => { void decide(proposal, 'approve'); }}
                  >
                    {busy && inFlight?.decision === 'approve' ? s.approving : s.approve}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    aria-busy={busy && inFlight?.decision === 'reject'}
                    onClick={() => { void decide(proposal, 'reject'); }}
                  >
                    {busy && inFlight?.decision === 'reject' ? s.rejecting : s.reject}
                  </Button>
                </div>
              ) : (
                <Badge tone="neutral">{s.decidedLabel}</Badge>
              )}
            </div>

            {!canDecide && outcome === undefined && (
              <p style={{ color: 'var(--warn)', fontSize: 'var(--text-xs)', marginBlockStart: 'var(--space-2)' }}>
                {s.cannotDecide}
              </p>
            )}

            {outcome !== undefined && <OutcomeBlock outcome={outcome} s={s} />}
          </Card>
        );
      })}

      {justDecided.length > 0 && (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <h3 style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)', margin: 0 }}>{s.justDecided}</h3>
          {justDecided.map(([id, outcome]) => (
            <div key={id} style={{
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--text-sm)',
            }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge tone={outcome.kind === 'executed' ? 'ok' : outcome.kind === 'failed' || outcome.kind === 'error' ? 'danger' : 'neutral'}>
                  {s.statuses[outcome.kind] ?? outcome.kind}
                </Badge>
                <Badge tone="accent">{s.actions[outcome.action] ?? outcome.action}</Badge>
                <span dir="auto">{outcome.summary}</span>
              </div>
              <OutcomeBlock outcome={outcome} s={s} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
