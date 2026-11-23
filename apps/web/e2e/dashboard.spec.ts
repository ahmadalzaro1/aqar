import { test, expect } from '@playwright/test';
import { login } from './helpers';

/**
 * The dashboard is a drawing of the portfolio, so the assertions are about the
 * drawing being real: tiles come from units, every tile is operable, the detail
 * panel answers a selection, and no catalogue key leaks into the page as text.
 */
test.describe('estate atlas', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'en');
  });

  test('the portfolio is drawn as sites made of flats', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Portfolio dashboard' })).toBeVisible();

    const tiles = page.locator('[data-atlas-tile]');
    await expect(tiles.first()).toBeVisible();
    expect(await tiles.count()).toBeGreaterThan(0);

    const statuses = await tiles.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset['status']),
    );
    for (const status of statuses) {
      expect(['occupied', 'vacant', 'turnover', 'unavailable']).toContain(status);
    }

    // Land is drawn per site, not once for the page.
    const sites = page.locator('article');
    expect(await sites.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await sites.count()); i += 1) {
      await expect(sites.nth(i).locator('[data-atlas-tile]').first()).toBeVisible();
    }
  });

  test('selecting a flat opens its detail panel', async ({ page }) => {
    const flat = page.locator('[data-atlas-tile][data-status="occupied"]').first();
    await flat.click();

    await expect(flat).toHaveAttribute('aria-pressed', 'true');
    const panel = page.locator('aside').filter({ has: page.locator('dl') });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/Rent/i);
    await expect(panel).toContainText(/Tenant/i);
  });

  test('arrow keys walk the elevation', async ({ page }) => {
    const first = page.locator('[data-atlas-tile]').first();
    await first.focus();
    const start = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));

    await page.keyboard.press('ArrowDown');
    const moved = await page.evaluate((from) => {
      const el = document.activeElement as HTMLElement | null;
      return el !== null && el.getAttribute('aria-label') !== from;
    }, start);

    expect(moved).toBe(true);
  });

  test('no untranslated catalogue keys reach the page', async ({ page }) => {
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/\batlas\.[a-z]/i);
    expect(text).not.toMatch(/unitStatus\./);
    expect(text).not.toMatch(/assetKind\./);
  });
});
