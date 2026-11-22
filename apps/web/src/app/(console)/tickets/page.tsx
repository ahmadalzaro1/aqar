import Link from 'next/link';
import { Card, Badge, EmptyState } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getMessages, t } from '@/i18n/server';
import { ticketsForOrg } from '@/lib/queries';

export default async function TicketsPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const m = await getMessages();
  const tickets = await ticketsForOrg(user.orgId, 100);
  const emergencies = tickets.filter(
    (tk) => tk.emergencyFlag && tk.status !== 'closed' && tk.status !== 'cancelled',
  );
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'tickets.title')}</h1>
      {emergencies.length > 0 && (
        <div
          role="alert"
          data-agent-dismissible="false"
          style={{
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--radius)',
            padding: 'var(--space-3)',
            fontWeight: 600,
          }}
        >
          {t(m, 'tickets.emergencyBanner')}
          <ul style={{ marginBlockStart: 8, fontWeight: 400 }}>
            {emergencies.map((tk) => (
              <li key={tk.id}>
                <Link href={`/tickets/${tk.id}`} style={{ color: 'inherit' }}>
                  {tk.text.slice(0, 80)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tickets.length === 0 ? (
        <EmptyState title={t(m, 'tickets.empty.title')} hint={t(m, 'tickets.empty.hint')} />
      ) : (
        <Card>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t(m, 'tickets.severity')}</th>
                  <th>{t(m, 'tickets.category')}</th>
                  <th>{t(m, 'ledger.unit')}</th>
                  <th>{t(m, 'tickets.channel')}</th>
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
                    <td>
                      <Link href={`/tickets/${tk.id}`}>{tk.category ?? tk.text.slice(0, 40)}</Link>
                    </td>
                    <td>
                      {tk.unitLabel ?? '—'} · {tk.propertyName}
                    </td>
                    <td>{tk.channel}</td>
                    <td>{t(m, `ticketStatus.${tk.status}`)}</td>
                    <td className="tnum">{tk.openedAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
