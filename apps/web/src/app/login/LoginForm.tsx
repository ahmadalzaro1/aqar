'use client';

import { useActionState } from 'react';
import type { Locale } from '@aqar/contracts';
import { Button } from '@aqar/ui';
import { loginAction, type LoginState } from './actions';

export function LoginForm({ locale, messages }: { locale: Locale; messages: Record<string, string> }) {
  const t = (key: string) => messages[key] ?? key;
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, { error: null });
  const field: React.CSSProperties = { display: 'grid', gap: 4, marginBlockEnd: 'var(--space-4)' };
  const label: React.CSSProperties = { fontSize: 'var(--text-sm)', fontWeight: 500 };
  return (
    <form action={formAction}>
      <h2 style={{ fontSize: 'var(--text-md)', marginBlockEnd: 'var(--space-4)' }}>{t('login.title')}</h2>
      <div style={field}>
        <label htmlFor="email" style={label}>{t('login.email')}</label>
        <input id="email" name="email" type="email" required autoComplete="username" dir="ltr" />
      </div>
      <div style={field}>
        <label htmlFor="password" style={label}>{t('login.password')}</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" dir="ltr" />
      </div>
      <div style={field}>
        <label htmlFor="totp" style={label}>{t('login.totp')}</label>
        <input id="totp" name="totp" type="text" inputMode="numeric" autoComplete="one-time-code" dir="ltr" placeholder="······" />
      </div>
      {state.error !== null && (
        <p role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', marginBlockEnd: 'var(--space-3)' }}>
          {t(state.error)}
        </p>
      )}
      <Button variant="primary" type="submit" disabled={pending} style={{ inlineSize: '100%' }}>
        {pending ? t('common.loading') : t('login.submit')}
      </Button>
      <input type="hidden" name="locale" value={locale} />
    </form>
  );
}
