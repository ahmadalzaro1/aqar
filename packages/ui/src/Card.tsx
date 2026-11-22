import type { ReactNode } from 'react';

export function Card({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-1)',
        padding: 'var(--space-4)',
        // Grid/flex items default to min-width:auto, which lets a wide table
        // blow out the card past the viewport on phones. Contain it instead.
        minInlineSize: 0,
      }}
    >
      {(title !== undefined || action !== undefined) && (
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBlockEnd: 'var(--space-3)',
          }}
        >
          <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 600, margin: 0 }}>{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
