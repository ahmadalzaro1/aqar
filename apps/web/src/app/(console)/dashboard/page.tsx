import Link from 'next/link';
import { Card, Badge, EmptyState, MoneyText, formatPercentBps } from '@aqar/ui';
import { occupancyRate, delinquencyRateBps, collectionRateBps } from '@aqar/core';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { unitsByStatus, ticketsForOrg, ticketCounts, collectionTotals } from '@/lib/queries';
import { currentPeriod } from '@/lib/period';

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const units = await unitsByStatus(user.orgId);
  const tickets = await ticketsForOrg(user.orgId, 8);
  const counts = await ticketCounts(user.orgId);
  const period = currentPeriod();
  const totals = await collectionTotals(user.orgId, period);

  if (units.length === 0) {
    return (
      <EmptyState
        title={t(m, 'dash.empty.title')}
        hint={t(m, 'dash.empty.hint')}
        action={
          <code style={{ background: 'var(--surface-3)', padding: '4px 8px', borderRadius: 6 }}>
            {t(m, 'dash.empty.action')}
          </code>
        }
      />
    );
  }

  const occ = occupancyRate(units.map((u) => ({ status: u.status })));
  // KPIs count the whole org; the recent-tickets table below is a LIMITed page.
  const openCount = counts.open;
  const emergencyCount = counts.emergencies;
  const delinq = delinquencyRateBps(Math.max(0, totals.billed - totals.collected), totals.billed);
  const coll = collectionRateBps(totals.collected, totals.billed);

  const nf = new Intl.NumberFormat(locale === 'ar' ? 'ar-JO' : 'en-US');
  const kpi = (label: string, value: string, tone?: 'danger' | 'ok' | 'warn') => (
    <Card>
      <p
        style={{
          color: 'var(--muted)',
          fontSize: 'var(--text-xs)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBlockEnd: 6,
        }}
      >
        {label}
      </p>
      <p
        className="tnum"
        style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 650,
          color:
            tone === 'danger'
              ? 'var(--danger)'
              : tone === 'ok'
                ? 'var(--ok)'
                : tone === 'warn'
                  ? 'var(--warn)'
                  : 'var(--ink)',
        }}
      >
        {value}
      </p>
    </Card>
  );

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'dash.title')}</h1>
      {emergencyCount > 0 && (
        <div
          role="alert"
          style={{
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--radius)',
            padding: 'var(--space-3)',
            fontWeight: 600,
          }}
        >
          {t(m, 'tickets.emergencyBanner')} ({nf.format(emergencyCount)})
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {kpi(t(m, 'dash.occupancy'), formatPercentBps(occ, locale))}
        {kpi(
          t(m, 'dash.collection'),
          formatPercentBps(coll, locale),
          coll >= 8000 ? 'ok' : coll < 5000 ? 'danger' : 'warn',
        )}
        {kpi(
          t(m, 'dash.delinquency'),
          formatPercentBps(delinq, locale),
          delinq > 0 ? 'danger' : undefined,
        )}
        {kpi(t(m, 'dash.openTickets'), nf.format(openCount))}
        {kpi(
          t(m, 'dash.emergencies'),
          nf.format(emergencyCount),
          emergencyCount > 0 ? 'danger' : undefined,
        )}
      </div>
      <Card
        title={t(m, 'dash.recentTickets')}
        action={<Link href="/tickets">{t(m, 'nav.tickets')}</Link>}
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t(m, 'tickets.severity')}</th>
                <th>{t(m, 'tickets.category')}</th>
                <th>{t(m, 'ledger.unit')}</th>
                <th>{t(m, 'tickets.status')}</th>
                <th>{t(m, 'tickets.opened')}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((tk) => (
                <tr key={tk.id}>
                  <td>
                    <Badge
                      tone={
                        tk.severity === 'emergency'
                          ? 'danger'
                          : tk.severity === 'high'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {tk.severity === null ? '—' : t(m, `sev.${tk.severity}`)}
                    </Badge>
                  </td>
                  <td>{tk.category ?? '—'}</td>
                  <td>
                    {tk.unitLabel ?? '—'} · {tk.propertyName}
                  </td>
                  <td>{t(m, `ticketStatus.${tk.status}`)}</td>
                  <td className="tnum">{tk.openedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
        {t(m, 'ledger.total')}: <MoneyText fils={totals.billed} locale={locale} /> · {period}
      </p>
    </div>
  );
}
