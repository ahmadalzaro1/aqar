import { EmptyState, MoneyText, formatPercentBps } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { portfolioByProperty } from '@/lib/queries';

export default async function PortfolioPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const rows = await portfolioByProperty(user.orgId);

  if (rows.length === 0) {
    return <EmptyState title={t(m, 'dash.empty.title')} hint={t(m, 'dash.empty.hint')} />;
  }
  const totalUnits = rows.reduce((s, r) => s + r.units, 0);
  const totalOccupied = rows.reduce((s, r) => s + r.occupied, 0);
  // "Not occupied" is units - occupied so the footer reconciles with the rows.
  // `turnover` and `unavailable` units are non-collecting too; the Leasing page
  // breaks them out by exact status.
  const totalNotOccupied = totalUnits - totalOccupied;
  const totalRent = rows.reduce((s, r) => s + r.marketRentFils, 0);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.portfolio')}</h1>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t(m, 'nav.portfolio')}</th>
              <th>{t(m, 'pf.district')}</th>
              <th>{t(m, 'pf.buildings')}</th>
              <th>{t(m, 'pf.units')}</th>
              <th>{t(m, 'pf.occupied')}</th>
              <th>{t(m, 'pf.vacant')}</th>
              <th>{t(m, 'pf.occupancy')}</th>
              <th>{t(m, 'pf.marketRent')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{locale === 'ar' ? r.nameAr : r.name}</td>
                <td>
                  {r.district ?? '—'}
                  {r.city === null ? '' : ` · ${r.city}`}
                </td>
                <td className="tnum">{r.buildings}</td>
                <td className="tnum">{r.units}</td>
                <td className="tnum">{r.occupied}</td>
                <td className="tnum">{r.units - r.occupied}</td>
                <td className="tnum">
                  {formatPercentBps(
                    r.units === 0 ? 0 : Math.round((r.occupied / r.units) * 10000),
                    locale,
                  )}
                </td>
                <td className="tnum">
                  <MoneyText fils={r.marketRentFils} locale={locale} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>{t(m, 'ledger.total')}</th>
              <th />
              <th className="tnum">{rows.reduce((s, r) => s + r.buildings, 0)}</th>
              <th className="tnum">{totalUnits}</th>
              <th className="tnum">{totalOccupied}</th>
              <th className="tnum">{totalNotOccupied}</th>
              <th className="tnum">
                {formatPercentBps(
                  totalUnits === 0 ? 0 : Math.round((totalOccupied / totalUnits) * 10000),
                  locale,
                )}
              </th>
              <th className="tnum">
                <MoneyText fils={totalRent} locale={locale} />
              </th>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
