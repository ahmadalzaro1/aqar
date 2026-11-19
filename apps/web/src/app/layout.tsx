import type { ReactNode } from 'react';
import { Inter, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { cookies } from 'next/headers';
import { getLocale } from '@/i18n/server';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'], weight: ['400', '500', '600', '700'],
  variable: '--font-plex-arabic', display: 'swap',
});

export const metadata = { title: 'Aqar — Property operations ledger' };
// Without this, mobile browsers fall back to a ~980px layout viewport and the
// console renders clipped at phone widths. Next injects the meta tag from it.
export const viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const store = await cookies();
  const theme = store.get('aqar_theme')?.value === 'dark' ? 'dark' : 'light';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} data-theme={theme}
      className={`${inter.variable} ${plexArabic.variable}`}>
      <body>{children}</body>
    </html>
  );
}
