import { Badge, EmptyState } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { vendorsForOrg } from '@/lib/queries';

export default async function VendorsPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const rows = await vendorsForOrg(user.orgId);

  if (rows.length === 0) {
    return <EmptyState title={t(m, 'ven.empty.title')} hint={t(m, 'ven.empty.hint')} />;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.vendors')}</h1>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t(m, 'ven.name')}</th>
              <th>{t(m, 'ven.trades')}</th>
              <th>{t(m, 'ven.contact')}</th>
              <th>{t(m, 'ven.rating')}</th>
              <th>{t(m, 'ven.insurance')}</th>
              <th>{t(m, 'ven.allowListed')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{locale === 'ar' ? r.nameAr : r.nameEn}</td>
                <td>{r.trades.length === 0 ? '—' : r.trades.join(' · ')}</td>
                <td dir="ltr">{r.phone ?? r.email ?? '—'}</td>
                <td className="tnum">{r.rating === null ? '—' : r.rating.toFixed(1)}</td>
                <td className="tnum">{r.insuranceExpiry ?? '—'}</td>
                <td>
                  <Badge tone={r.allowListed ? 'ok' : 'warn'}>
                    {r.allowListed ? t(m, 'ven.allowListed') : '—'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
