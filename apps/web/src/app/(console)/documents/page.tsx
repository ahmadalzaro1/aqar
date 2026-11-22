import { Badge, EmptyState } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getMessages, t } from '@/i18n/server';
import { documentsForOrg } from '@/lib/queries';

export default async function DocumentsPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const m = await getMessages();
  const rows = await documentsForOrg(user.orgId);

  if (rows.length === 0) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.documents')}</h1>
        <EmptyState title={t(m, 'doc.empty.title')} hint={t(m, 'doc.empty.hint')} />
      </div>
    );
  }

  const kb = (b: number | null) => (b === null ? '—' : `${Math.round(b / 1024)} KB`);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'nav.documents')}</h1>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t(m, 'ven.name')}</th>
              <th>{t(m, 'doc.entity')}</th>
              <th>{t(m, 'doc.version')}</th>
              <th>{t(m, 'doc.size')}</th>
              <th>{t(m, 'doc.status')}</th>
              <th>{t(m, 'doc.uploaded')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.title}</td>
                <td>{r.entityType}</td>
                <td className="tnum">
                  v{r.version}
                  {r.isLatest ? ' ✓' : ''}
                </td>
                <td className="tnum">{kb(r.bytes)}</td>
                <td>
                  <Badge tone="neutral">{r.status}</Badge>
                </td>
                <td className="tnum">{r.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
