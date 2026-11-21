import { redirect } from 'next/navigation';
import { Badge, Card, EmptyState } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale } from '@/i18n/server';
import { sql } from '@/lib/db';
import { ProposalQueue } from './ProposalQueue';
import { ReversalButton } from './ReversalButton';
import { stringsFor } from './copy';
import { argEntries, stamp, statusTone } from './format';
import type { DecidedProposal, PendingProposal } from './types';

// Mirrors APPROVER_ROLES in app/api/proposals/[id]/decision/route.ts. The server
// enforces it; this only decides whether to warn the viewer up front.
const APPROVER_ROLES = new Set(['owner_admin', 'accountant', 'property_manager']);

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export default async function ProposalsPage() {
  const user = await getSessionUser();
  if (user === null) redirect('/login');
  const locale = await getLocale();
  const s = stringsFor(locale);

  // Both queries are scoped by organization_id: the proposal handlers and the
  // approval executor are what make these rows consequential, so never read
  // another org's queue even if a policy regresses.
  const pendingRows = await sql`
    SELECT id, action, tool_name, summary, args, model_id, created_at, expires_at
    FROM action_proposals
    WHERE organization_id = ${user.orgId} AND status = 'pending'
    ORDER BY expires_at ASC`;

  const decidedRows = await sql`
    SELECT p.id, p.action, p.summary, p.status, p.decided_at, p.result,
           u.name_en, u.name_ar, r.reversed_at, r.reason AS reversal_reason
    FROM action_proposals p
    LEFT JOIN users u ON u.id = p.decided_by_user_id
    LEFT JOIN proposal_reversals r ON r.proposal_id = p.id
    WHERE p.organization_id = ${user.orgId}
      AND p.status IN ('approved', 'rejected', 'expired', 'executed', 'failed', 'reversed')
    ORDER BY p.decided_at DESC NULLS LAST
    LIMIT 10`;

  const now = Date.now();
  const pending: PendingProposal[] = pendingRows.map((r) => {
    const createdAt = asDate(r['created_at']);
    const expiresAt = asDate(r['expires_at']);
    const modelId = r['model_id'];
    return {
      id: String(r['id']),
      action: String(r['action']),
      toolName: String(r['tool_name']),
      summary: String(r['summary']),
      modelId: typeof modelId === 'string' ? modelId : null,
      createdAt: stamp(createdAt, locale),
      createdIso: createdAt === null ? '' : createdAt.toISOString(),
      expiresAt: stamp(expiresAt, locale),
      expiresIso: expiresAt === null ? '' : expiresAt.toISOString(),
      expired: expiresAt !== null && expiresAt.getTime() < now,
      args: argEntries(r['args'], locale),
    };
  });

  const decided: DecidedProposal[] = decidedRows.map((r) => {
    const decidedAt = asDate(r['decided_at']);
    const result = r['result'];
    const resultObject = typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
    const error = resultObject?.['error'];
    // Reversibility is a claim about the database, not about the button: an
    // execution the read-back never confirmed has no effect to undo, and a row
    // that already has a reversal receipt cannot produce a second one.
    const reversible = String(r['status']) === 'executed'
      && resultObject?.['confirmed'] === true
      && r['reversed_at'] === null;
    const reversalReason = typeof r['reversal_reason'] === 'string' ? r['reversal_reason'] : '';
    const nameEn = r['name_en'];
    const nameAr = r['name_ar'];
    const name = locale === 'ar'
      ? (typeof nameAr === 'string' ? nameAr : typeof nameEn === 'string' ? nameEn : null)
      : (typeof nameEn === 'string' ? nameEn : typeof nameAr === 'string' ? nameAr : null);
    return {
      id: String(r['id']),
      action: String(r['action']),
      summary: String(r['summary']),
      status: String(r['status']),
      decidedAt: stamp(decidedAt, locale),
      decidedIso: decidedAt === null ? '' : decidedAt.toISOString(),
      decidedBy: name,
      note: typeof error === 'string' ? error : '',
      reversible,
      reversalReason,
    };
  });

  const canDecide = APPROVER_ROLES.has(user.role);

  return (
    // The chat dock floats over the bottom-left corner of every console page; the
    // trailing space keeps the last row's buttons clear of it.
    <div style={{ display: 'grid', gap: 'var(--space-4)', paddingBlockEnd: 'calc(var(--space-4) * 4)' }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 'var(--text-xl)' }}>{s.title}</h1>
          <Badge tone={pending.length > 0 ? 'accent' : 'neutral'}>{s.pendingCount(pending.length)}</Badge>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{s.hint}</p>
      </div>

      <Card title={`${s.pendingTitle} · ${pending.length}`}>
        {pending.length === 0 ? (
          <EmptyState title={s.emptyPendingTitle} hint={s.emptyPendingHint} />
        ) : (
          <ProposalQueue proposals={pending} locale={locale} canDecide={canDecide} />
        )}
      </Card>

      <Card title={s.decidedTitle}>
        {decided.length === 0 ? (
          <EmptyState title={s.emptyDecidedTitle} hint={s.emptyDecidedHint} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{s.status}</th>
                  <th>{s.summary}</th>
                  <th>{s.action}</th>
                  <th>{s.decidedAt}</th>
                  <th>{s.decidedBy}</th>
                  <th>{s.reversal}</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((row) => (
                  <tr key={row.id}>
                    <td><Badge tone={statusTone(row.status)}>{s.statuses[row.status] ?? row.status}</Badge></td>
                    <td>
                      {row.summary}
                      {row.note !== '' && (
                        <div style={{ color: 'var(--danger)', fontSize: 'var(--text-xs)' }} dir="auto">
                          {s.reason}: {row.note}
                        </div>
                      )}
                      {row.reversalReason !== '' && (
                        <div style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)' }} dir="auto">
                          {s.reversedBecause} {row.reversalReason}
                        </div>
                      )}
                    </td>
                    <td>{s.actions[row.action] ?? row.action}</td>
                    <td className="tnum" title={row.decidedIso}>{row.decidedAt}</td>
                    <td>{row.decidedBy ?? s.system}</td>
                    <td>
                      <ReversalButton
                        proposalId={row.id}
                        locale={locale}
                        reversible={row.reversible && canDecide}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
