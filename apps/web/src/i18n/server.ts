import { cookies } from 'next/headers';
import type { Locale } from '@aqar/contracts';
import en from './messages/en.json';
import ar from './messages/ar.json';

const catalogues: Record<Locale, Record<string, string>> = { en, ar };

export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get('aqar_locale')?.value;
  return v === 'en' ? 'en' : 'ar'; // Arabic-first default
}

export async function getMessages(): Promise<Record<string, string>> {
  return catalogues[await getLocale()];
}

export function t(messages: Record<string, string>, key: string): string {
  return messages[key] ?? key;
}
