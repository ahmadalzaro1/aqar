import { Card, MoneyText, formatPercentBps } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import Link from 'next/link';
import { occupancyRate, delinquencyRateBps, collectionRateBps } from '@aqar/core';
import { portfolioByProperty, unitsByStatus, collectionTotals } from '@/lib/queries';
import { currentPeriod } from '@/lib/period';

export default async function ReportsPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const period = currentPeriod();
  const [units, props, totals] = await Promise.all([
    unitsByStatus(user.orgId), portfolioByProperty(user.orgId), collectionTotals(user.orgId, period),
  ]);

  const occ = occupancyRate(units.map((u) => ({ status: u.status })));
  const coll = collectionRateBps(totals.collected, totals.billed);
  const delinq = delinquencyRateBps(Math.max(0, totals.billed - totals.collected), totals.billed);
  const nf = new Intl.NumberFormat(locale === 'ar' ? 'ar-JO' : 'en-US');

  const kpi = (label: string, value: string) => (
    <Card>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBlockEnd: 6 }}>{label}</p>
      <p className="tnum" style={{ fontSize: 'var(--text-2xl)', fontWeight: 650 }}>{value}</p>
    </Card>
  );

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.reports')}</h1>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{t(m, 'rep.period')}: {period}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 'var(--space-4)' }}>
        {kpi(t(m, 'dash.occupancy'), formatPercentBps(occ, locale))}
        {kpi(t(m, 'dash.collection'), formatPercentBps(coll, locale))}
        {kpi(t(m, 'dash.delinquency'), formatPercentBps(delinq, locale))}
        {kpi(t(m, 'ledger.total'), nf.format(totals.billed / 1000))}
      </div>
      <Card title={t(m, 'rep.byProperty')} action={<Link href="/statements">{t(m, 'rep.statements')}</Link>}>
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>{t(m, 'nav.portfolio')}</th><th>{t(m, 'pf.units')}</th>
              <th>{t(m, 'pf.occupied')}</th><th>{t(m, 'pf.occupancy')}</th><th>{t(m, 'pf.marketRent')}</th>
            </tr></thead>
            <tbody>
              {props.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{locale === 'ar' ? r.nameAr : r.name}</td>
                  <td className="tnum">{r.units}</td>
                  <td className="tnum">{r.occupied}</td>
                  <td className="tnum">{formatPercentBps(r.units === 0 ? 0 : Math.round((r.occupied / r.units) * 10000), locale)}</td>
                  <td className="tnum"><MoneyText fils={r.marketRentFils} locale={locale} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
