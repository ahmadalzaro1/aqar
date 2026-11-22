'use client';

// The dispatch board on a ticket. Every decision it shows was made server-side:
// this component collects a human's intent, calls one action, and re-reads.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge } from '@aqar/ui';
import {
  acceptDispatch,
  approveWorkOrder,
  completeWorkOrder,
  declineDispatch,
  offerDispatch,
  recordQuote,
  type DispatchResult,
} from './dispatch-actions';
import type { DispatchStrings } from './dispatch-dict';
import type { DispatchBoard, SpendPolicy } from './dispatch-queries';

export interface PanelVendor {
  readonly id: string;
  readonly name: string;
  readonly score: number | null;
  readonly rating: number | null;
  readonly phone: string | null;
}

export interface SlaView {
  readonly responseDueAt: string | null;
  readonly resolutionDueAt: string | null;
  readonly respondedAt: string | null;
  readonly resolvedAt: string | null;
  readonly responseBreached: boolean;
  readonly resolutionBreached: boolean;
}

const rowStyle = { display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' } as const;
const fieldStyle = { display: 'grid', gap: 4, minWidth: 160 } as const;
const inputStyle = {
  padding: 'var(--space-2)',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  background: 'var(--surface-1)',
  color: 'var(--foreground)',
} as const;

function fmt(iso: string | null): string {
  if (iso === null) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

export function DispatchPanel(props: {
  readonly ticketId: string;
  readonly vendors: readonly PanelVendor[];
  readonly board: DispatchBoard;
  readonly sla: SlaView | null;
  readonly policy: SpendPolicy;
  readonly s: DispatchStrings;
}): React.JSX.Element {
  const { s, ticketId, vendors, board } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? '');
  const [scope, setScope] = useState('');
  const [nte, setNte] = useState('');
  const [quoteVendor, setQuoteVendor] = useState(vendors[0]?.id ?? '');
  const [quoteAmount, setQuoteAmount] = useState('');
  const [quoteLead, setQuoteLead] = useState('');
  const [quoteNotes, setQuoteNotes] = useState('');
  const [completeId, setCompleteId] = useState<string | null>(
    board.workOrders.find((w) => w.status === 'in_progress' || w.status === 'dispatched')?.id ??
      null,
  );
  const [cost, setCost] = useState('');

  const run = (call: () => Promise<DispatchResult>): void => {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await call();
      if (result.status === 'ok') {
        setNote('✓');
        setScope('');
        setNte('');
        setQuoteAmount('');
        setQuoteLead('');
        setQuoteNotes('');
        setCost('');
        router.refresh();
        return;
      }
      if (result.status === 'needs_approval') {
        setNote(s.needsApproval);
        router.refresh();
        return;
      }
      if (result.status === 'conflict') {
        setError(s.errors[result.detail] ?? result.detail);
        router.refresh();
        return;
      }
      if (result.status === 'invalid') {
        setError(s.errors[result.detail] ?? result.detail);
        return;
      }
      setError(s.errors['unauthorized'] ?? 'unauthorized');
    });
  };

  const nteJod = Number(nte);
  const nteKnown = Number.isFinite(nteJod) && nteJod >= 0;
  const aboveAutoApprove = nteKnown && nteJod * 1000 > props.policy.autoApproveUnderFils;
  const aboveHardCeiling = nteKnown && nteJod * 1000 > props.policy.nteCeilingFils;

  return (
    <>
      <Card title={s.slaTitle}>
        {props.sla === null ? (
          <p style={{ color: 'var(--muted)' }}>{s.slaNoClock}</p>
        ) : (
          <div className="tnum" style={{ ...rowStyle, fontSize: 'var(--text-sm)' }}>
            <span>
              {s.slaResponseDue}: {fmt(props.sla.responseDueAt)}
              {props.sla.responseBreached ? ' ' : ''}
              {props.sla.responseBreached && <Badge tone="danger">{s.slaBreached}</Badge>}
            </span>
            <span>
              {s.slaResolutionDue}: {fmt(props.sla.resolutionDueAt)}
              {props.sla.resolutionBreached && <Badge tone="danger">{s.slaBreached}</Badge>}
            </span>
            <span>
              {s.slaResponded}: {fmt(props.sla.respondedAt)}
            </span>
            <span>
              {s.slaResolved}: {fmt(props.sla.resolvedAt)}
            </span>
          </div>
        )}
      </Card>

      <Card title={s.title}>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{s.subtitle}</p>
        {vendors.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>{s.noVendors}</p>
        ) : (
          <form
            style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}
            onSubmit={(event) => {
              event.preventDefault();
              run(() => offerDispatch({ ticketId, vendorId, scopeMd: scope, nteJod: nte }));
            }}
          >
            <div style={rowStyle}>
              <label style={fieldStyle}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
                  {s.vendor}
                </span>
                <select
                  style={inputStyle}
                  value={vendorId}
                  onChange={(event) => setVendorId(event.target.value)}
                >
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.score === null ? ` · ${s.unproven}` : ` · ${s.score} ${v.score}`}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldStyle}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{s.nte}</span>
                <input
                  style={inputStyle}
                  inputMode="decimal"
                  placeholder="75.500"
                  value={nte}
                  onChange={(event) => setNte(event.target.value)}
                />
              </label>
            </div>
            <label style={fieldStyle}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{s.scope}</span>
              <textarea
                style={{ ...inputStyle, minHeight: 64 }}
                placeholder={s.scopePlaceholder}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              />
            </label>
            <p
              style={{
                fontSize: 'var(--text-xs)',
                color: aboveAutoApprove ? 'var(--danger)' : 'var(--muted)',
              }}
            >
              {aboveHardCeiling
                ? s.abovePolicyCeiling
                : aboveAutoApprove
                  ? s.needsApproval
                  : s.nteHint}
            </p>
            <div style={rowStyle}>
              <button type="submit" disabled={pending || aboveHardCeiling} style={inputStyle}>
                {pending ? s.working : s.offer}
              </button>
              {error !== null && (
                <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
                  {error}
                </span>
              )}
              {note !== null && error === null && (
                <span style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{note}</span>
              )}
            </div>
          </form>
        )}
      </Card>

      {board.dispatches.length > 0 && (
        <Card title={s.offersTitle}>
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {board.dispatches.map((d) => (
              <li
                key={d.id}
                style={{
                  background: 'var(--surface-2)',
                  borderRadius: 'var(--radius)',
                  padding: 'var(--space-3)',
                }}
              >
                <p style={rowStyle}>
                  <strong>{d.vendorName}</strong>
                  <Badge tone={d.status === 'accepted' ? 'ok' : 'neutral'}>{d.status}</Badge>
                  <span className="tnum" style={{ color: 'var(--muted)' }}>
                    {fmt(d.offeredAt)}
                  </span>
                </p>
                {d.note !== null && <p style={{ color: 'var(--muted)' }}>{d.note}</p>}
                {d.status === 'offered' && (
                  <div style={{ ...rowStyle, marginTop: 8 }}>
                    <button
                      type="button"
                      disabled={pending}
                      style={inputStyle}
                      onClick={() => run(() => acceptDispatch(d.id))}
                    >
                      {s.accept}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      style={inputStyle}
                      onClick={() => run(() => declineDispatch(d.id, ''))}
                    >
                      {s.decline}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {board.workOrders.length > 0 && (
        <Card title={s.workOrdersTitle}>
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {board.workOrders.map((w) => (
              <li
                key={w.id}
                style={{
                  background: 'var(--surface-2)',
                  borderRadius: 'var(--radius)',
                  padding: 'var(--space-3)',
                }}
              >
                <p style={rowStyle}>
                  <strong>{w.vendorName}</strong>
                  <Badge tone={w.status === 'completed' ? 'ok' : 'info'}>{w.status}</Badge>
                  <span className="tnum">
                    {s.ceiling}: {w.nteFils === null ? '—' : (w.nteFils / 1000).toFixed(3)}
                  </span>
                </p>
                <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{w.scopeMd}</p>
                <div style={{ ...rowStyle, marginTop: 8 }}>
                  {w.status === 'draft' && (
                    <button
                      type="button"
                      disabled={pending}
                      style={inputStyle}
                      onClick={() => run(() => approveWorkOrder(w.id))}
                    >
                      {s.approve}
                    </button>
                  )}
                  {(w.status === 'dispatched' || w.status === 'in_progress') && (
                    <>
                      <input
                        style={{ ...inputStyle, width: 120 }}
                        inputMode="decimal"
                        placeholder={s.cost}
                        value={completeId === w.id ? cost : ''}
                        onFocus={() => setCompleteId(w.id)}
                        onChange={(event) => {
                          setCompleteId(w.id);
                          setCost(event.target.value);
                        }}
                      />
                      <button
                        type="button"
                        disabled={pending || completeId !== w.id}
                        style={inputStyle}
                        onClick={() =>
                          run(() =>
                            completeWorkOrder({ workOrderId: w.id, costJod: cost, notes: '' }),
                          )
                        }
                      >
                        {s.complete}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={s.quotesTitle}>
        {board.quotes.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>{s.quotesEmpty}</p>
        ) : (
          <table style={{ width: '100%', fontSize: 'var(--text-sm)', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textAlign: 'start' }}>
                <th style={{ textAlign: 'start', padding: 4 }}>{s.vendor}</th>
                <th style={{ textAlign: 'start', padding: 4 }}>{s.amount}</th>
                <th style={{ textAlign: 'start', padding: 4 }}>{s.leadDays}</th>
                <th style={{ textAlign: 'start', padding: 4 }}>{s.status}</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {board.quotes.map((q) => (
                <tr key={q.id}>
                  <td style={{ padding: 4 }}>{q.vendorName}</td>
                  <td style={{ padding: 4 }}>{(q.amountFils / 1000).toFixed(3)}</td>
                  <td style={{ padding: 4 }}>{q.leadTimeDays ?? '—'}</td>
                  <td style={{ padding: 4 }}>
                    {q.selected ? <Badge tone="ok">✓</Badge> : <Badge>{s.notSelected}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {vendors.length > 0 && (
          <form
            style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}
            onSubmit={(event) => {
              event.preventDefault();
              const lead = quoteLead.trim() === '' ? null : Number(quoteLead);
              run(() =>
                recordQuote({
                  ticketId,
                  vendorId: quoteVendor,
                  amountJod: quoteAmount,
                  leadTimeDays: lead !== null && Number.isInteger(lead) ? lead : null,
                  notes: quoteNotes,
                }),
              );
            }}
          >
            <div style={rowStyle}>
              <label style={fieldStyle}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
                  {s.vendor}
                </span>
                <select
                  style={inputStyle}
                  value={quoteVendor}
                  onChange={(event) => setQuoteVendor(event.target.value)}
                >
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldStyle}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
                  {s.amount}
                </span>
                <input
                  style={inputStyle}
                  inputMode="decimal"
                  placeholder="45.000"
                  value={quoteAmount}
                  onChange={(event) => setQuoteAmount(event.target.value)}
                />
              </label>
              <label style={fieldStyle}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
                  {s.leadDays}
                </span>
                <input
                  style={inputStyle}
                  inputMode="numeric"
                  placeholder="2"
                  value={quoteLead}
                  onChange={(event) => setQuoteLead(event.target.value)}
                />
              </label>
            </div>
            <label style={fieldStyle}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{s.notes}</span>
              <input
                style={inputStyle}
                value={quoteNotes}
                onChange={(event) => setQuoteNotes(event.target.value)}
              />
            </label>
            <div style={rowStyle}>
              <button type="submit" disabled={pending} style={inputStyle}>
                {pending ? s.working : s.save}
              </button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}
