import { Card, Badge } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { usersForOrg, orgName } from '@/lib/queries';

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const [users, org] = await Promise.all([usersForOrg(user.orgId), orgName(user.orgId)]);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.settings')}</h1>
      <Card title={t(m, 'shell.org')}>
        <p style={{ fontWeight: 600 }}>{org}</p>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{t(m, 'app.tagline')}</p>
      </Card>
      <Card title={t(m, 'set.users')}>
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>{t(m, 'set.name')}</th><th>{t(m, 'set.email')}</th>
              <th>{t(m, 'set.role')}</th><th>{t(m, 'set.status')}</th>
            </tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>{locale === 'ar' ? u.nameAr : u.nameEn}</td>
                  <td dir="ltr">{u.email}</td>
                  <td>{t(m, `role.${u.role}`)}</td>
                  <td><Badge tone={u.isActive ? 'ok' : 'neutral'}>{u.isActive ? t(m, 'set.active') : t(m, 'set.inactive')}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
