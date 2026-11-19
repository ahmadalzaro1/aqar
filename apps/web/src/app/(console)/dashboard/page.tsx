import Link from 'next/link';
import { Card, Badge, EmptyState, MoneyText, formatPercentBps } from '@aqar/ui';
import { occupancyRate, delinquencyRateBps, collectionRateBps } from '@aqar/core';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { unitsByStatus, ticketsForOrg, collectionTotals } from '@/lib/queries';
import { currentPeriod } from '@/lib/period';

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const units = await unitsByStatus(user.orgId);
  const tickets = await ticketsForOrg(user.orgId, 8);
  const period = currentPeriod();
  const totals = await collectionTotals(user.orgId, period);

  if (units.length === 0) {
    return <EmptyState title={t(m, 'dash.empty.title')} hint={t(m, 'dash.empty.hint')}
      action={<code style={{ background: 'var(--surface-3)', padding: '4px 8px', borderRadius: 6 }}>{t(m, 'dash.empty.action')}</code>} />;
  }

  const occ = occupancyRate(units.map((u) => ({ status: u.status })));
  const openTickets = tickets.filter((tk) => tk.status !== 'closed' && tk.status !== 'cancelled');
  const emergencies = openTickets.filter((tk) => tk.emergencyFlag);
  const delinq = delinquencyRateBps(Math.max(0, totals.billed - totals.collected), totals.billed);
  const coll = collectionRateBps(totals.collected, totals.billed);

  const kpi = (label: string, value: string, tone?: 'danger' | 'ok') => (
    <Card>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBlockEnd: 6 }}>{label}</p>
      <p className="tnum" style={{ fontSize: 'var(--text-2xl)', fontWeight: 650, color: tone === 'danger' ? 'var(--danger)' : tone === 'ok' ? 'var(--ok)' : 'var(--ink)' }}>{value}</p>
    </Card>
  );

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'dash.title')}</h1>
      {emergencies.length > 0 && (
        <div role="alert" style={{
          background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid var(--danger)',
          borderRadius: 'var(--radius)', padding: 'var(--space-3)', fontWeight: 600,
        }}>
          {t(m, 'tickets.emergencyBanner')} ({emergencies.length})
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)' }}>
        {kpi(t(m, 'dash.occupancy'), formatPercentBps(occ, locale))}
        {kpi(t(m, 'dash.collection'), formatPercentBps(coll, locale), 'ok')}
        {kpi(t(m, 'dash.delinquency'), formatPercentBps(delinq, locale), delinq > 0 ? 'danger' : undefined)}
        {kpi(t(m, 'dash.openTickets'), String(openTickets.length))}
        {kpi(t(m, 'dash.emergencies'), String(emergencies.length), emergencies.length > 0 ? 'danger' : undefined)}
      </div>
      <Card title={t(m, 'dash.recentTickets')} action={<Link href="/tickets">{t(m, 'nav.tickets')}</Link>}>
        <table>
          <thead><tr>
            <th>{t(m, 'tickets.severity')}</th><th>{t(m, 'tickets.category')}</th>
            <th>{t(m, 'ledger.unit')}</th><th>{t(m, 'tickets.status')}</th><th>{t(m, 'tickets.opened')}</th>
          </tr></thead>
          <tbody>
            {tickets.map((tk) => (
              <tr key={tk.id}>
                <td><Badge tone={tk.severity === 'emergency' ? 'danger' : tk.severity === 'high' ? 'warn' : 'neutral'}>
                  {tk.severity === null ? '—' : t(m, `sev.${tk.severity}`)}
                </Badge></td>
                <td>{tk.category ?? '—'}</td>
                <td>{tk.unitLabel ?? '—'} · {tk.propertyName}</td>
                <td>{tk.status}</td>
                <td className="tnum">{tk.openedAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
        {t(m, 'ledger.total')}: <MoneyText fils={totals.billed} locale={locale} /> · {period}
      </p>
    </div>
  );
}
