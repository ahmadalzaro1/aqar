'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { logout } from './auth';

export async function setLocale(locale: 'ar' | 'en'): Promise<void> {
  const store = await cookies();
  store.set('aqar_locale', locale, { path: '/', maxAge: 365 * 24 * 3600 });
}

export async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  const store = await cookies();
  store.set('aqar_theme', theme, { path: '/', maxAge: 365 * 24 * 3600 });
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect('/login');
}
