import { Card, Badge, EmptyState, MoneyText } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { unitsNeedingTenant } from '@/lib/queries';

export default async function LeasingPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const rows = await unitsNeedingTenant(user.orgId);

  if (rows.length === 0) {
    return <EmptyState title={t(m, 'ls.empty.title')} hint={t(m, 'ls.empty.hint')} />;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.leasing')}</h1>
      <Card title={`${t(m, 'nav.leasing')} · ${rows.length}`}>
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>{t(m, 'nav.portfolio')}</th><th>{t(m, 'ls.unit')}</th><th>{t(m, 'ls.floor')}</th>
              <th>{t(m, 'ls.bedrooms')}</th><th>{t(m, 'ls.area')}</th>
              <th>{t(m, 'ls.rent')}</th><th>{t(m, 'tickets.status')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.propertyName}</td>
                  <td style={{ fontWeight: 600 }}>{r.unitNumber}</td>
                  <td className="tnum">{r.floor ?? '—'}</td>
                  <td className="tnum">{r.bedrooms ?? '—'}</td>
                  <td className="tnum">{r.areaSqm === null ? '—' : r.areaSqm.toFixed(0)}</td>
                  <td className="tnum"><MoneyText fils={r.marketRentFils} locale={locale} /></td>
                  <td><Badge tone={r.status === 'turnover' ? 'warn' : 'neutral'}>{t(m, `unitStatus.${r.status}`)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
