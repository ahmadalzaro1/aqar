import { EmptyState, formatPercentBps } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { ownersForOrg } from '@/lib/queries';

export default async function OwnersPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const rows = await ownersForOrg(user.orgId);

  if (rows.length === 0) {
    return <EmptyState title={t(m, 'own.empty.title')} hint={t(m, 'own.empty.hint')} />;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.owners')}</h1>
      <div className="table-scroll">
        <table>
          <thead><tr>
            <th>{t(m, 'own.name')}</th><th>{t(m, 'own.properties')}</th>
            <th>{t(m, 'own.share')}</th><th>{t(m, 'own.contact')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{locale === 'ar' ? r.nameAr : r.nameEn}</td>
                <td className="tnum">{r.properties}</td>
                <td className="tnum">{formatPercentBps(r.shareBps, locale)}</td>
                <td dir="ltr">{r.email ?? r.phone ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
