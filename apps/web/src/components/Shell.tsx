'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Locale } from '@aqar/contracts';
import {
  LayoutDashboard, Building2, Inbox, FileText, BookOpen, Wrench,
  Truck, Users, FolderLock, BarChart3, Settings, Search, Languages, Moon, Sun, LogOut,
} from 'lucide-react';
import { setLocale, setTheme, logoutAction } from '@/lib/actions';
import type { SessionUser } from '@/lib/auth';

const NAV = [
  { href: '/dashboard', key: 'nav.dashboard', Icon: LayoutDashboard },
  { href: '/portfolio', key: 'nav.portfolio', Icon: Building2 },
  { href: '/leasing', key: 'nav.leasing', Icon: Inbox },
  { href: '/leases', key: 'nav.leases', Icon: FileText },
  { href: '/ledger', key: 'nav.ledger', Icon: BookOpen },
  { href: '/tickets', key: 'nav.tickets', Icon: Wrench },
  { href: '/vendors', key: 'nav.vendors', Icon: Truck },
  { href: '/owners', key: 'nav.owners', Icon: Users },
  { href: '/documents', key: 'nav.documents', Icon: FolderLock },
  { href: '/reports', key: 'nav.reports', Icon: BarChart3 },
  { href: '/settings', key: 'nav.settings', Icon: Settings },
] as const;

export function Shell({ user, orgName, locale, messages, children }: {
  user: SessionUser; orgName: string; locale: Locale;
  messages: Record<string, string>; children: ReactNode;
}) {
  const t = (key: string) => messages[key] ?? key;
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(
    () => NAV.filter((n) => t(n.key).toLowerCase().includes(query.toLowerCase())),
    [query, messages],
  );

  const iconBtn: React.CSSProperties = {
    background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--ink)', cursor: 'pointer', padding: 6, display: 'inline-flex', minHeight: 32, minWidth: 32,
    alignItems: 'center', justifyContent: 'center',
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <a href="#main" className="no-print" style={{ position: 'absolute', insetInlineStart: -9999 }}
        onFocus={(e) => { e.currentTarget.style.insetInlineStart = '8px'; }}
        onBlur={(e) => { e.currentTarget.style.insetInlineStart = '-9999px'; }}>
        Skip to content
      </a>
      <aside className="no-print" style={{
        inlineSize: collapsed ? 56 : 220, flexShrink: 0, background: 'var(--surface-2)',
        borderInlineEnd: '1px solid var(--border)', padding: 'var(--space-3)',
        display: 'flex', flexDirection: 'column', gap: 2, transition: 'inline-size 150ms ease',
      }}>
        <button onClick={() => setCollapsed((v) => !v)} style={{ ...iconBtn, marginBlockEnd: 'var(--space-3)' }}
          aria-label="Toggle sidebar">
          <Building2 size={16} />
          {!collapsed && <strong style={{ marginInlineStart: 8 }}>{t('app.name')}</strong>}
        </button>
        {NAV.map(({ href, key, Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} title={t(key)} style={{
              display: 'flex', alignItems: 'center', gap: 8, paddingBlock: 7, paddingInline: 8,
              borderRadius: 'var(--radius)', fontSize: 'var(--text-sm)', fontWeight: active ? 600 : 400,
              color: active ? 'var(--accent)' : 'var(--ink)',
              background: active ? 'var(--accent-soft)' : 'transparent', textDecoration: 'none',
            }}>
              <Icon size={15} strokeWidth={1.75} />
              {!collapsed && <span>{t(key)}</span>}
            </Link>
          );
        })}
      </aside>
      <div style={{ flex: 1, minInlineSize: 0, display: 'flex', flexDirection: 'column' }}>
        <header className="no-print" style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          paddingBlock: 'var(--space-2)', paddingInline: 'var(--space-4)',
          borderBlockEnd: '1px solid var(--border)', background: 'var(--surface)',
        }}>
          <button onClick={() => setPaletteOpen(true)} style={{ ...iconBtn, gap: 6, color: 'var(--muted)' }}>
            <Search size={14} /> <span style={{ fontSize: 'var(--text-xs)' }}>{t('nav.search')}</span>
            <kbd style={{ fontSize: 10, border: '1px solid var(--border)', borderRadius: 3, paddingInline: 4 }}>⌘K</kbd>
          </button>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{orgName}</span>
          <div style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={iconBtn} aria-label={t('shell.locale')}
              onClick={async () => { await setLocale(locale === 'ar' ? 'en' : 'ar'); router.refresh(); }}>
              <Languages size={15} />
            </button>
            <button style={iconBtn} aria-label={t('shell.theme')}
              onClick={async () => {
                const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', next);
                await setTheme(next);
              }}>
              {<Moon size={15} />}
            </button>
            <span style={{ fontSize: 'var(--text-sm)' }}>{locale === 'ar' ? user.nameAr : user.nameEn}</span>
            <form action={logoutAction}>
              <button style={iconBtn} aria-label={t('shell.logout')} type="submit"><LogOut size={15} /></button>
            </form>
          </div>
        </header>
        <main id="main" style={{ padding: 'var(--space-6)', maxInlineSize: 1280, inlineSize: '100%', marginInline: 'auto' }}>
          {children}
        </main>
      </div>
      {paletteOpen && (
        <div role="dialog" aria-modal="true" aria-label={t('shell.commandPalette')}
          onClick={() => setPaletteOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgb(0 0 0 / 0.35)', display: 'grid', placeItems: 'start center', paddingBlockStart: '12vh', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            inlineSize: 480, maxInlineSize: 'calc(100vw - 32px)', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-2)', overflow: 'hidden',
          }}>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={t('nav.search')} aria-label={t('nav.search')}
              style={{ inlineSize: '100%', border: 'none', borderBlockEnd: '1px solid var(--border)', borderRadius: 0, padding: 'var(--space-3)' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const first = filtered[0];
                  if (first !== undefined) { setPaletteOpen(false); router.push(first.href); }
                }
              }} />
            <ul style={{ listStyle: 'none', margin: 0, padding: 'var(--space-2)', maxBlockSize: 320, overflowY: 'auto' }}>
              {filtered.map(({ href, key, Icon }) => (
                <li key={href}>
                  <Link href={href} onClick={() => setPaletteOpen(false)} style={{
                    display: 'flex', gap: 8, alignItems: 'center', paddingBlock: 8, paddingInline: 8,
                    borderRadius: 'var(--radius)', color: 'var(--ink)', fontSize: 'var(--text-sm)',
                  }}>
                    <Icon size={14} /> {t(key)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
