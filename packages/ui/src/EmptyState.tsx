import type { ReactNode } from 'react';

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div style={{
      textAlign: 'center', padding: 'var(--space-10)', color: 'var(--muted)',
      border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)',
    }}>
      <p style={{ fontWeight: 600, color: 'var(--ink)', marginBlockEnd: 'var(--space-2)' }}>{title}</p>
      {hint !== undefined && <p style={{ marginBlockEnd: 'var(--space-4)' }}>{hint}</p>}
      {action}
    </div>
  );
}
