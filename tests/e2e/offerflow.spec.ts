import { test, expect, type Page } from '@playwright/test';

/**
 * Golden-path E2E against the production build. These cover the wiring
 * unit tests cannot: SPA served by Express, real fetch round-trips,
 * optimistic UI settling against real server responses, dialogs.
 *
 * Serial suite, one shared seeded DB. Tests that mutate use unique
 * company names; the destructive reset test runs last.
 */

const COLUMNS = ['Wishlist', 'Applied', 'Screening', 'Interview', 'Offer', 'Rejected'];

async function createApplication(page: Page, company: string, position: string): Promise<void> {
  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill(position);
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form).toBeHidden();
}

test('board loads with all six pipeline columns and seeded cards', async ({ page }) => {
  await page.goto('/');
  for (const label of COLUMNS) {
    await expect(page.getByRole('region', { name: `${label} column` })).toBeVisible();
  }
  // The seed dataset guarantees at least one card in Wishlist.
  const wishlist = page.getByRole('region', { name: 'Wishlist column' });
  await expect(wishlist.locator('article.card').first()).toBeVisible();
});

test('create → card appears → status move via drawer → search → dashboard', async ({ page }) => {
  const company = `E2E Corp ${Date.now()}`;
  await page.goto('/');

  // Create through the real form.
  await createApplication(page, company, 'Platform Engineer');
  const wishlist = page.getByRole('region', { name: 'Wishlist column' });
  const card = wishlist.locator('article.card', { hasText: company });
  await expect(card).toBeVisible();

  // Open the detail drawer and move to Interview via the status select.
  await card.click();
  const drawer = page.getByRole('dialog', { name: 'Application details' });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel('Application status').selectOption('interview');
  // Optimistic move: the card re-buckets without a reload.
  await expect(
    page
      .getByRole('region', { name: 'Interview column' })
      .locator('article.card', { hasText: company }),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();

  // Server-side search narrows the board to the new card.
  await page.getByLabel('Search applications').fill(company);
  await expect(page.locator('article.card')).toHaveCount(1);
  await expect(page.locator('article.card')).toContainText(company);
  await page.getByLabel('Search applications').fill('');

  // Dashboard renders aggregates from the real API.
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByText('Total applications')).toBeVisible();
  await expect(page.getByText('Response rate')).toBeVisible();
});

test('edit an application through the form and see the change persist', async ({ page }) => {
  const company = `Edit Me ${Date.now()}`;
  await page.goto('/');
  await createApplication(page, company, 'QA Engineer');

  const card = page.locator('article.card', { hasText: company });
  await card.click();
  const drawer = page.getByRole('dialog', { name: 'Application details' });
  await drawer.getByRole('button', { name: 'Edit' }).click();

  const form = page.getByRole('dialog', { name: 'Edit application' });
  await form.getByPlaceholder('Frontend Engineer').fill('Senior QA Engineer');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form).toBeHidden();

  // The drawer (still open on the same app) reflects the saved position.
  await expect(drawer).toContainText('Senior QA Engineer');
  await drawer.getByRole('button', { name: 'Close' }).click();

  // And it survives a full reload — the server really persisted it.
  await page.reload();
  await expect(page.locator('article.card', { hasText: company })).toContainText(
    'Senior QA Engineer',
  );
});

test('server-side validation errors surface inline without creating a card', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  const company = `Bad Salary ${Date.now()}`;
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill('Role');
  // salaryMin > salaryMax passes HTML validation but fails the zod refine
  // on the server — a genuine API round-trip, not a client-side guard.
  await form.getByPlaceholder('70000').fill('90000');
  await form.getByPlaceholder('90000').fill('70000');
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form.getByText('Please fix the highlighted fields.')).toBeVisible();
  await expect(form.getByText('salaryMin must not exceed salaryMax')).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('article.card', { hasText: company })).toHaveCount(0);
});

test('delete removes the card after confirming the dialog', async ({ page }) => {
  const company = `Delete Me ${Date.now()}`;
  await page.goto('/');
  await createApplication(page, company, 'Temp Role');
  const card = page.locator('article.card', { hasText: company });
  await expect(card).toBeVisible();

  await card.click();
  const drawer = page.getByRole('dialog', { name: 'Application details' });
  page.once('dialog', (dialog) => void dialog.accept());
  await drawer.getByRole('button', { name: 'Delete' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('article.card', { hasText: company })).toHaveCount(0);
});

test('reset demo restores the seed dataset (runs last, destructive)', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Reset demo' }).click();
  // The canonical seed contains Wolt; after reset it is back on the board.
  await expect(page.locator('article.card', { hasText: 'Wolt' }).first()).toBeVisible();
  await expect(page.locator('article.card', { hasText: 'E2E Corp' })).toHaveCount(0);
});
