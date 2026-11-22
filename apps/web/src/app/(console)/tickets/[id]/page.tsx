import { notFound } from 'next/navigation';
import { Card, Badge, EmptyState } from '@aqar/ui';
import { sql } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { getMessages, t } from '@/i18n/server';
import { ticketMessages } from '@/lib/queries';

export default async function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (user === null) return null;
  const { id } = await params;
  const m = await getMessages();
  const rows = await sql`
    SELECT tk.id, tk.status, tk.emergency_flag, tk.opened_at, tk.channel, tk.body,
      cl.category, cl.severity, cl.confidence, cl.deterministic_emergency, cl.model_severity,
      r.responsibility
    FROM tickets tk
    LEFT JOIN LATERAL (
      SELECT category, severity, confidence, deterministic_emergency, model_severity
      FROM classifications WHERE ticket_id = tk.id ORDER BY created_at DESC LIMIT 1
    ) cl ON true
    LEFT JOIN LATERAL (
      SELECT responsibility FROM responsibilities WHERE ticket_id = tk.id
      ORDER BY created_at DESC LIMIT 1
    ) r ON true
    WHERE tk.id = ${id} AND tk.organization_id = ${user.orgId} LIMIT 1`;
  const tk = rows[0];
  if (tk === undefined) notFound();
  const messages = await ticketMessages(id);
  const traces =
    await sql`SELECT id, steps, total_tokens, total_latency_ms, handed_off_to_human FROM agent_traces WHERE ticket_id = ${id} ORDER BY id`;
  const emergency = Boolean(tk['emergency_flag']);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {emergency && (
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
        </div>
      )}
      <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'ticket.detail')}</h1>
      <Card title={String(tk['body'])}>
        <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone={emergency ? 'danger' : 'neutral'}>{String(tk['severity'] ?? '—')}</Badge>
          <Badge>{String(tk['category'] ?? '—')}</Badge>
          <Badge>{String(tk['status'])}</Badge>
          <Badge>{String(tk['channel'])}</Badge>
          {tk['responsibility'] !== null && (
            <Badge tone="info">{String(tk['responsibility'])}</Badge>
          )}
        </p>
      </Card>
      <Card title={t(m, 'ticket.classification')}>
        <p className="tnum" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>
          {t(m, 'ticket.confidence')}: {tk['confidence'] === null ? '—' : String(tk['confidence'])}{' '}
          · deterministic_emergency: {String(tk['deterministic_emergency'] ?? false)} ·
          model_severity: {String(tk['model_severity'] ?? '—')}
        </p>
      </Card>
      <Card title={t(m, 'ticket.messages')}>
        {messages.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>—</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {messages.map((msg, i) => (
              <li
                key={i}
                style={{
                  background: 'var(--surface-2)',
                  borderRadius: 'var(--radius)',
                  padding: 'var(--space-3)',
                }}
              >
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
                  {msg.sender} · <span className="tnum">{msg.at.slice(0, 16)}</span>
                </p>
                <p>{msg.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t(m, 'ticket.trace')}>
        {traces.length === 0 ? (
          <EmptyState title={t(m, 'ticket.trace.empty')} />
        ) : (
          <pre style={{ fontSize: 'var(--text-xs)', overflowX: 'auto' }}>
            {JSON.stringify(traces, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  );
}
