import { Badge, EmptyState, MoneyText } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { leasesForOrg } from '@/lib/queries';

export default async function LeasesPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const rows = await leasesForOrg(user.orgId);

  if (rows.length === 0) {
    return <EmptyState title={t(m, 'lea.empty.title')} hint={t(m, 'lea.empty.hint')} />;
  }
  const annual = rows.reduce((s, r) => s + r.rentFils, 0);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.leases')}</h1>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t(m, 'lea.tenant')}</th>
              <th>{t(m, 'ledger.unit')}</th>
              <th>{t(m, 'lea.start')}</th>
              <th>{t(m, 'lea.end')}</th>
              <th>{t(m, 'lea.rent')}</th>
              <th>{t(m, 'lea.deposit')}</th>
              <th>{t(m, 'lea.dueDay')}</th>
              <th>{t(m, 'tickets.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{locale === 'ar' ? r.tenantAr : r.tenantEn}</td>
                <td>
                  {r.unitNumber} · {r.propertyName}
                </td>
                <td className="tnum">{r.startDate}</td>
                <td className="tnum">{r.endDate}</td>
                <td className="tnum">
                  <MoneyText fils={r.rentFils} locale={locale} />
                </td>
                <td className="tnum">
                  <MoneyText fils={r.depositFils} locale={locale} />
                </td>
                <td className="tnum">{r.dueDay}</td>
                <td>
                  <Badge tone={r.status === 'active' ? 'ok' : 'neutral'}>
                    {t(m, `leaseStatus.${r.status}`)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={4}>{t(m, 'ledger.total')}</th>
              <th className="tnum">
                <MoneyText fils={annual} locale={locale} />
              </th>
              <th colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
