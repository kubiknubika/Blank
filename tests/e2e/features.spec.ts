import { test, expect } from '@playwright/test';

/**
 * Round-7 features against the production build: archive lifecycle,
 * CSV round-trip, theme persistence, markdown notes. Each test signs
 * into the shared demo account first (the suite runs before the
 * destructive reset in offerflow.spec.ts... actually after auth.spec.ts
 * and before offerflow.spec.ts alphabetically? No: 'features' < 'offerflow',
 * so this runs BEFORE the tracker suite — keep the seed intact: use
 * unique company names and clean up nothing the seed owns).
 */

test.beforeEach(async ({ page }) => {
  const res = await page.request.post('/api/auth/demo');
  expect(res.status()).toBe(200);
});

test('archive → leaves board → archive view → restore → back on board', async ({ page }) => {
  const company = `Archive E2E ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill('SRE');
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form).toBeHidden();

  const card = page.locator('article.card', { hasText: company });
  await card.click();
  const drawer = page.getByRole('dialog', { name: 'Application details' });
  await drawer.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(card).toHaveCount(0);

  // Archive view shows it with a Restore action.
  await page.getByRole('button', { name: '📂 Archive' }).click();
  const archivedCard = page.locator('article.card', { hasText: company });
  await expect(archivedCard).toBeVisible();
  await archivedCard.click();
  await drawer.getByRole('button', { name: 'Restore' }).click();
  await expect(drawer).toBeHidden();
  await expect(archivedCard).toHaveCount(0);

  // Back on the active board it reappears.
  await page.getByRole('button', { name: '📂 Archive' }).click();
  await expect(page.locator('article.card', { hasText: company })).toBeVisible();
});

test('CSV export → import into a fresh account preserves data', async ({ page, request }) => {
  const stamp = Date.now();
  const company = `Csv E2E ${stamp}`;
  await page.goto('/');
  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill('Data Engineer');
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form).toBeHidden();

  // Export via the API (same session cookie jar as the page).
  const exported = await page.request.get('/api/export/csv');
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-type']).toContain('text/csv');
  const csv = await exported.text();
  expect(csv).toContain(company);

  // Import into a brand-new account via the API.
  const reg = await request.post('/api/auth/register', {
    data: { email: `csv-e2e-${stamp}@example.com`, password: 'csv-e2e-password' },
  });
  expect(reg.status()).toBe(201);
  const cookie = reg.headers()['set-cookie'].split(';')[0];
  const imported = await request.post('/api/import/csv', {
    headers: { Cookie: cookie },
    data: { csv },
  });
  expect(imported.status()).toBe(201);
  const { imported: count } = (await imported.json()) as { imported: number };
  expect(count).toBeGreaterThanOrEqual(1);

  const list = await request.get('/api/applications?limit=500', {
    headers: { Cookie: cookie },
  });
  const apps = (await list.json()) as { company: string }[];
  expect(apps.some((a) => a.company === company)).toBe(true);

  // A malformed file is rejected atomically.
  const bad = await request.post('/api/import/csv', {
    headers: { Cookie: cookie },
    data: { csv: 'company,position\n,Missing\n' },
  });
  expect(bad.status()).toBe(400);
});

test('theme toggle persists across reload', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  // Restore for the next tests.
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('markdown notes render safely in the drawer', async ({ page }) => {
  const company = `Md E2E ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill('FE');
  await form
    .getByLabel('Notes')
    .fill('**prepare** system design\n\n- review `STAR` stories\n- [job](https://example.com)');
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form).toBeHidden();

  await page.locator('article.card', { hasText: company }).click();
  const drawer = page.getByRole('dialog', { name: 'Application details' });
  const md = drawer.locator('.markdown');
  await expect(md.locator('strong')).toHaveText('prepare');
  await expect(md.locator('code')).toHaveText('STAR');
  await expect(md.locator('li')).toHaveCount(2);
  await expect(md.getByRole('link', { name: 'job' })).toHaveAttribute(
    'href',
    'https://example.com',
  );
});
