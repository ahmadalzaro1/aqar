import { expect, type Page } from '@playwright/test';

/** Dev fixture seeded by `pnpm db:seed` (public, documented in packages/db/src/seed.ts). */
export const DEV_ADMIN = { email: 'admin@aqar.example', password: 'aqar-dev-admin-123' } as const;

export type Locale = 'en' | 'ar';

/** The app reads its locale from this cookie (see apps/web/src/i18n/server.ts). */
export async function setLocale(page: Page, locale: Locale): Promise<void> {
  await page.context().addCookies([{ name: 'aqar_locale', value: locale, path: '/' }]);
}

export async function login(page: Page, locale: Locale = 'en'): Promise<void> {
  await setLocale(page, locale);
  await page.goto('/login');
  await page.fill('input[name="email"]', DEV_ADMIN.email);
  await page.fill('input[name="password"]', DEV_ADMIN.password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('main#main')).toBeVisible();
}

/** A money cell in either locale: "JOD 1,160.000" or "١٬١٦٠٫٠٠٠ د.أ". */
export const MONEY_RE = /(JOD\s[\d,]+\.\d{3})|([\u0660-\u0669\u06f0-\u06f9][\u0660-\u0669\u06f0-\u06f9\u066b\u066c]*\s*د\.أ)/u;

/** Parse either representation back to integer fils, so totals can be compared as numbers. */
export function moneyToFils(text: string): number {
  const latin = text.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const arabicDigits = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const normalised =
    /[\u0660-\u0669]/.test(text)
      ? arabicDigits.replace(/[^\d\u066b\u066c.,-]/g, '').replace(/\u066c/g, '').replace(/\u066b/g, '.')
      : latin;
  const value = Number.parseFloat(normalised.replace(/,/g, ''));
  return Math.round(value * 1000);
}

export async function rowCount(page: Page, selector = 'tbody tr'): Promise<number> {
  return page.locator(selector).count();
}
