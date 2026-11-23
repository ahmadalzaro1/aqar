import { expect, test } from '@playwright/test';
import { login, setLocale } from './helpers';

test.describe('authentication', () => {
  test('the form asks for an email address only', async ({ page }) => {
    await setLocale(page, 'en');
    await page.goto('/login');
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toHaveCount(0);
    await expect(page.locator('input[name="totp"]')).toHaveCount(0);
  });

  test('an unregistered email is rejected and no session is created', async ({ page }) => {
    await setLocale(page, 'en');
    await page.goto('/login');
    await page.fill('input[name="email"]', 'nobody@not-on-this-ledger.example');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('form p[role="alert"]')).toBeVisible();
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'aqar_session' && c.value.length > 0);
    expect(session, 'a rejected sign-in must not set a session cookie').toBeUndefined();
  });

  test('a malformed email is rejected without a session', async ({ page }) => {
    await setLocale(page, 'en');
    await page.goto('/login');
    await page.fill('input[name="email"]', 'not-an-email');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login/);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'aqar_session' && c.value.length > 0)).toBeUndefined();
  });

  test('seeded admin logs in and reaches the dashboard', async ({ page }) => {
    await login(page, 'en');
    await page.goto('/dashboard');
    await expect(page.locator('main#main h1')).toHaveText(/dashboard/i);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('the same account works in Arabic and the document flips to RTL', async ({ page }) => {
    await login(page, 'ar');
    await page.goto('/dashboard');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('main#main h1')).not.toHaveText(/dashboard/i);
  });

  test('an unauthenticated deep link is redirected to /login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/statements');
    await expect(page).toHaveURL(/\/login/);
  });
});
