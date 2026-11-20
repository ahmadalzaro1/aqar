import { expect, test } from '@playwright/test';
import { DEV_ADMIN, login, setLocale } from './helpers';

test.describe('authentication', () => {
  test('wrong password is rejected and no session is created', async ({ page }) => {
    await setLocale(page, 'en');
    await page.goto('/login');
    await page.fill('input[name="email"]', DEV_ADMIN.email);
    await page.fill('input[name="password"]', 'definitely-not-the-password');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login/);
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'aqar_session' && c.value.length > 0);
    expect(session, 'a failed login must not set a session cookie').toBeUndefined();
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
