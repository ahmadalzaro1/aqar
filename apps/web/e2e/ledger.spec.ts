import { expect, test } from '@playwright/test';
import { MONEY_RE, login, moneyToFils } from './helpers';

/**
 * The ledger is the money contract at the UI boundary: every amount is integer
 * fils rendered with exactly three decimals, and the collected total equals the
 * sum of the paid rows. These assertions are arithmetic, not screenshots.
 */
test.describe('rent ledger money invariants', () => {
  test('every amount is a three-decimal JOD figure', async ({ page }) => {
    await login(page, 'en');
    await page.goto('/ledger');
    const rows = page.locator('table.money tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    expect(await page.locator('table.money thead th').count()).toBe(7);

    for (let i = 0; i < count; i += 1) {
      const cells = rows.nth(i).locator('td');
      const amount = (await cells.nth(3).innerText()).trim();
      const paid = (await cells.nth(4).innerText()).trim();
      const balance = (await cells.nth(5).innerText()).trim();
      for (const [label, value] of [
        ['amount', amount],
        ['paid', paid],
        ['balance', balance],
      ] as const) {
        expect(value, `row ${i} ${label} "${value}" must be a JOD figure`).toMatch(MONEY_RE);
        // 3 decimals in latin digits, 3 in arabic-indic
        const decimals = value.includes('٫')
          ? value.split('٫')[1]?.replace(/[^\u0660-\u0669\u06f0-\u06f9]/g, '')
          : value.split('.')[1]?.replace(/[^\d]/g, '');
        expect(decimals?.length, `row ${i} ${label} "${value}" must carry exactly 3 decimals`).toBe(
          3,
        );
      }
      expect(moneyToFils(balance)).toBe(Math.max(0, moneyToFils(amount) - moneyToFils(paid)));
    }
  });

  test('the same ledger in Arabic renders the same figures', async ({ page }) => {
    await login(page, 'en');
    await page.goto('/ledger');
    const english = await page
      .locator('table.money tbody tr')
      .evaluateAll((trs) =>
        trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim())),
      );

    await page.context().addCookies([{ name: 'aqar_locale', value: 'ar', path: '/' }]);
    await page.goto('/ledger');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const arabic = await page
      .locator('table.money tbody tr')
      .evaluateAll((trs) =>
        trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim())),
      );

    expect(arabic.length).toBe(english.length);
    for (let i = 0; i < english.length; i += 1) {
      const en = english[i] ?? [];
      const ar = arabic[i] ?? [];
      // amount, paid, balance must be numerically identical across locales
      for (const col of [3, 4, 5]) {
        expect(
          moneyToFils(ar[col] ?? ''),
          `row ${i} col ${col}: "${en[col]}" vs "${ar[col]}"`,
        ).toBe(moneyToFils(en[col] ?? ''));
      }
    }
  });
});
