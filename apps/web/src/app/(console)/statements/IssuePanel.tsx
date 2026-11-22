'use client';

// Human approval gate: nothing persists until this button is clicked.
import { useState } from 'react';
import { Button } from '@aqar/ui';
import { issueStatement } from './actions';
import type { IssueResult } from './actions';
import type { StatementStrings } from './dict';

export function IssuePanel({
  propertyId,
  period,
  s,
  alreadyIssued,
  blocked,
}: {
  propertyId: string;
  period: string;
  s: StatementStrings;
  alreadyIssued: boolean;
  blocked: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  async function issue() {
    setBusy(true);
    try {
      setResult(await issueStatement(propertyId, period));
    } catch {
      setResult({ status: 'blocked', detail: 'request failed' });
    } finally {
      setBusy(false);
    }
  }
  const message =
    result === null
      ? null
      : result.status === 'issued'
        ? `${s.issueDone} (${String(result.drafts)} ${s.issueDrafts})`
        : result.status === 'already_issued'
          ? s.issueExisting
          : result.status === 'blocked'
            ? `${s.issueBlocked}: ${result.detail}`
            : result.status === 'unauthorized'
              ? s.issueError
              : s.issueError;
  return (
    <div className="no-print" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <h2 style={{ fontSize: 'var(--text-lg)' }}>{s.issueTitle}</h2>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{s.issueHint}</p>
      <div
        style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}
      >
        <Button variant="primary" onClick={issue} disabled={busy || blocked || alreadyIssued}>
          {busy ? s.issuePending : alreadyIssued ? s.issuedBadge : s.issueButton}
        </Button>
        <Button
          onClick={() => {
            window.print();
          }}
        >
          {s.print}
        </Button>
      </div>
      {message !== null && (
        <p role="status" aria-live="polite" style={{ fontSize: 'var(--text-sm)' }}>
          {message}
        </p>
      )}
    </div>
  );
}
