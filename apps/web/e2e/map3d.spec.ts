import { expect, test } from '@playwright/test';

/**
 * The 3D view is the second view of the same portfolio rows: a real map with the
 * buildings extruded on their deed coordinates. These tests guard the contract
 * that makes it trustworthy — the view is reachable, the coordinates shown are
 * the recorded ones, the massing claims are labelled as derived, and switching
 * sites moves the record panel (not just the camera).
 *
 * WebGL runs on SwiftShader in CI (see playwright.config.ts) so the map itself
 * is exercised rather than stubbed.
 */

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.fill('input[name="email"]', 'admin@aqar.com');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/dashboard/);
}

test('the 3D view draws the portfolio on a real map', async ({ page }) => {
  await signIn(page);
  await page.goto('/dashboard?view=3d');

  // The two views are one togglable control, with the map marked current.
  const toggle = page.getByRole('navigation', { name: /طريقة عرض المحفظة|Portfolio view/ });
  await expect(toggle).toBeVisible();
  await expect(toggle.getByRole('link', { name: /خريطة تفاعلية|3D map/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Both sites are offered with the coordinates that are on the record.
  const chips = page.locator('[data-site-chip]');
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toContainText('31.9441');
  await expect(chips.first()).toContainText('35.8792');
  await expect(chips.nth(1)).toContainText('31.9512');

  // The map has to actually initialise: tiles render into a MapLibre canvas.
  const frame = page.locator('[data-map3d]');
  await expect(frame.locator('canvas').first()).toBeVisible({ timeout: 45_000 });
  const size = await frame
    .locator('canvas')
    .first()
    .evaluate((c: HTMLCanvasElement) => ({
      w: c.width,
      h: c.height,
    }));
  expect(size.w).toBeGreaterThan(100);
  expect(size.h).toBeGreaterThan(100);

  // Derived geometry must say so, in the visitor's language. The note sits in
  // the legend row beside the map, not inside the map frame.
  await expect(page.getByText(/مساحات الطوابق|recorded floor areas/)).toBeVisible();

  // The record panel starts on a site summary, and states the counts the map draws.
  const panel = page.locator('[data-map3d-panel]');
  await expect(panel).toContainText('عبدون');
  await expect(panel).toContainText('12');
  await expect(panel).toContainText('4');
});

test('exploding separates the real plates, and the note says it is a transform', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/dashboard?view=3d');

  const frame = page.locator('[data-map3d]');
  await expect(frame.locator('canvas').first()).toBeVisible({ timeout: 45_000 });

  // Wait for the plates to exist, then measure the stack as drawn.
  await expect
    .poll(async () => page.evaluate(() => window.__aqarPlates?.length ?? 0))
    .toBeGreaterThan(1);

  const spread = async () => {
    const ys: number[] = await page.evaluate(() => window.__aqarPlates ?? []);
    return Math.max(...ys) - Math.min(...ys);
  };

  const stacked = await spread();
  const toggle = page.locator('[data-explode-toggle]');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // The transform must actually move geometry: plates gain air between them.
  await expect.poll(spread, { timeout: 10_000 }).toBeGreaterThan(stacked + 5);

  // Vacancy is the signal the toggle exists for: every vacant flat must sit
  // above every occupied one by more than half a storey.
  // The lift is animated, so poll the settled value rather than sampling a frame
  // mid-transition (an early read sees ~1.5 m and fails on timing, not geometry).
  const lift = () =>
    page.evaluate(() => {
      const all = Object.values(window.__aqarUnits ?? {});
      const vacant = all.filter((u) => u.status === 'vacant').map((u) => u.y);
      const occupied = all.filter((u) => u.status === 'occupied').map((u) => u.y);
      if (vacant.length === 0 || occupied.length === 0) return 0;
      return Math.min(...vacant) - Math.max(...occupied);
    });
  await expect.poll(lift, { timeout: 10_000 }).toBeGreaterThan(2);

  // ...and it must never read as a measured dimension.
  await expect(
    page.getByText(/المسافة بين الطوابق|plate spacing is a display transform/),
  ).toBeVisible();

  // Collapsing puts the stack back where it started.
  await toggle.click();
  await expect.poll(spread, { timeout: 10_000 }).toBeLessThan(stacked + 1);
});

test('the Overture context apron renders and is labelled height-not-recorded', async ({ page }) => {
  await signIn(page);
  await page.goto('/dashboard?view=3d');
  await expect(page.locator('[data-map3d] canvas').first()).toBeVisible({ timeout: 45_000 });

  // Attribution is a licence obligation, and the height caveat is an honesty one.
  await expect(page.locator('[data-map3d-note]')).toContainText(/مباني الجوار|Context buildings/);
  await expect(page.locator('[data-apron-credit]')).toContainText('Overture');

  // The layer really carries the generated footprints (620 across both sites),
  // measured off the live MapLibre instance rather than off the React tree.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const map = window.__aqarMap;
          if (!map || map.getSource('apron') === undefined) return 0;
          return map.querySourceFeatures('apron').length;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(50);
});

test('switching site moves the record, and the plan view still works', async ({ page }) => {
  await signIn(page);
  await page.goto('/dashboard?view=3d');

  const panel = page.locator('[data-map3d-panel]');
  await expect(panel).toContainText('عبدون');

  await page.locator('[data-site-chip]').nth(1).click();
  await expect(panel).toContainText('الويبدية');

  // Back to the drawn elevation: the default view must not regress because the
  // map exists.
  await page.goto('/dashboard?view=plan');
  await expect(page.locator('[data-map3d]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /البنايات|Buildings/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
