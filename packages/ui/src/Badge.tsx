import type { ReactNode } from 'react';

type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok' | 'info';
const tones: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--surface-3)', fg: 'var(--muted)' },
  accent: { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
  danger: { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
  warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)' },
  ok: { bg: 'var(--ok-soft)', fg: 'var(--ok)' },
  info: { bg: 'var(--info-soft)', fg: 'var(--ink)' },
};
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const t = tones[tone];
  return (
    <span style={{
      background: t.bg, color: t.fg, borderRadius: 'var(--radius-sm)',
      fontSize: 'var(--text-xs)', fontWeight: 600, paddingInline: 6, paddingBlock: 2,
      display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}
