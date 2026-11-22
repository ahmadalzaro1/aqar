export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            height: 14,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-3)',
            inlineSize: `${85 - i * 12}%`,
          }}
        />
      ))}
    </div>
  );
}
