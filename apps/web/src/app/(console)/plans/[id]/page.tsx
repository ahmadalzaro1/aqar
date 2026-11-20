import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, EmptyState } from '@aqar/ui';
import { reconcileAreas } from '@aqar/core';
import { getSessionUser } from '@/lib/auth';
import { getMessages, t } from '@/i18n/server';
import { planDetail } from '@/lib/plan-queries';
import { confirmRoomAction, proposeUnitsAction } from '../actions';

export default async function PlanReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getSessionUser();
  if (user === null) return null;
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const m = await getMessages();
  const detail = await planDetail(user.orgId, id);
  if (detail === null) notFound();

  const { plan, rooms, warnings, strategy } = detail;
  const lettable = rooms.filter((room) => room.kind === 'unit');
  const reconciliation = reconcileAreas(
    lettable.map((room) => ({ code: room.code, areaSqm: room.areaSqm })),
    plan.statedAreaSqm,
  );
  const verdictTone =
    reconciliation.verdict === 'within' ? 'ok' : reconciliation.verdict === 'outside' ? 'danger' : 'neutral';
  const confirmedUnits = lettable.filter((room) => room.confirmedAt !== null).length;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <header style={{ display: 'grid', gap: 'var(--space-1)' }}>
        <Link href="/plans" style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
          ← {t(m, 'plan.title')}
        </Link>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>{plan.propertyName} · {plan.level}</h1>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge tone="neutral">{plan.format} · {plan.drawingUnit}</Badge>
          {/* Provenance, not decoration: rings were drawn, walls were closed by the
              extractor's polygonizer. Same number, different level of trust. */}
          <Badge tone="neutral">{t(m, `plan.strategy.${strategy}`)}</Badge>
          <Badge tone="neutral">{plan.status}</Badge>
          <Badge tone={verdictTone}>
            {t(m, `plan.verdict.${reconciliation.verdict}`)}
            {reconciliation.deviationPct === null
              ? ''
              : ` · ${(reconciliation.deviationPct * 100).toFixed(2)}%`}
          </Badge>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
            {t(m, 'plan.lettable')}: <span className="tnum">{reconciliation.sumSqm.toFixed(3)} m²</span>
            {reconciliation.statedSqm === null
              ? ''
              : ` / ${t(m, 'plan.stated')}: ${reconciliation.statedSqm.toFixed(3)} m²`}
          </span>
        </div>
        {warnings.length > 0 && (
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
            {t(m, 'plan.warnings')}: {warnings.join(', ')}
          </p>
        )}
      </header>

      {!reconciliation.verdict.startsWith('within') && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
          {reconciliation.verdict === 'no_statement' ? t(m, 'plan.no_statement.hint') : t(m, 'plan.outside.hint')}
        </p>
      )}

      {error === 'nothing_confirmed' && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--destructive, #b42318)' }}>
          {t(m, 'plan.error.nothing_confirmed')}
        </p>
      )}

      {rooms.length === 0 ? (
        <EmptyState title={t(m, 'plan.empty.rooms')} hint={t(m, 'plan.empty.rooms.hint')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t(m, 'plan.room')}</th>
                <th>{t(m, 'plan.label')}</th>
                <th>{t(m, 'plan.kind')}</th>
                <th>{t(m, 'plan.area')}</th>
                <th>{t(m, 'plan.source')}</th>
                <th>{t(m, 'plan.confirmed')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.code}>
                  <td className="tnum" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{room.code}</td>
                  <td>{room.label ?? '—'}</td>
                  <td><Badge tone={room.kind === 'unit' ? 'accent' : 'neutral'}>{room.kind}</Badge></td>
                  <td className="tnum">{room.areaSqm.toFixed(2)}</td>
                  <td style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
                    {room.source}
                                        {room.confidence === null
                      ? ''
                      : ` · ${t(m, 'plan.confidence')} ${room.confidence.toFixed(2)}`}
                  </td>
                  <td style={{ fontSize: 'var(--text-xs)' }}>
                    {room.confirmedAt ?? <span style={{ color: 'var(--muted-foreground)' }}>—</span>}
                  </td>
                  <td>
                    {room.confirmedAt === null && (
                      <form action={confirmRoomAction}>
                        <input type="hidden" name="planId" value={plan.id} />
                        <input type="hidden" name="code" value={room.code} />
                        <button type="submit" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)' }}>
                          {t(m, 'plan.confirm')}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section style={{ display: 'grid', gap: 'var(--space-2)', maxWidth: 620 }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>{t(m, 'plan.propose')}</strong>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>{t(m, 'plan.propose.hint')}</p>
        <form action={proposeUnitsAction}>
          <input type="hidden" name="planId" value={plan.id} />
          <button
            type="submit"
            disabled={confirmedUnits === 0}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              opacity: confirmedUnits === 0 ? 0.5 : 1,
            }}
          >
            {t(m, 'plan.propose.action')} ({confirmedUnits})
          </button>
        </form>
      </section>
    </div>
  );
}
