import { getLocale, getMessages, t } from '@/i18n/server';
import { LoginForm } from './LoginForm';

export default async function LoginPage() {
  const locale = await getLocale();
  const m = await getMessages();
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--surface-2)',
      }}
    >
      <div
        style={{
          inlineSize: 380,
          maxInlineSize: 'calc(100vw - 32px)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-2)',
          padding: 'var(--space-8)',
        }}
      >
        <h1 style={{ fontSize: 'var(--text-xl)', marginBlockEnd: 4 }}>{t(m, 'app.name')}</h1>
        <p style={{ color: 'var(--muted)', marginBlockEnd: 'var(--space-6)' }}>
          {t(m, 'app.tagline')}
        </p>
        <LoginForm locale={locale} messages={m} />
      </div>
    </main>
  );
}
