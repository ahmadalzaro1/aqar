import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './format.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}
const base: React.CSSProperties = {
  borderRadius: 'var(--radius)',
  fontSize: 'var(--text-sm)',
  fontWeight: 500,
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  minHeight: 32,
  border: '1px solid transparent',
  cursor: 'pointer',
  transition: 'background 120ms ease, transform 120ms ease',
};
const variants: Record<Variant, React.CSSProperties> = {
  primary: { background: 'var(--accent)', color: 'var(--accent-ink)' },
  secondary: { background: 'var(--surface-2)', color: 'var(--ink)', borderColor: 'var(--border)' },
  ghost: { background: 'transparent', color: 'var(--ink)' },
  danger: { background: 'var(--danger)', color: '#fff' },
};
export function Button({ variant = 'secondary', children, className, style, ...rest }: Props) {
  return (
    <button
      className={cn('aqar-btn', className)}
      style={{ ...base, ...variants[variant], ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}
