import { test, expect, type Page } from '@playwright/test';

/**
 * Auth golden paths against the production build: the sign-in screen,
 * registration, session persistence across reloads, sign-out, and the
 * hard boundary between two accounts' data.
 *
 * Runs BEFORE offerflow.spec.ts (alphabetical) and never touches the
 * demo dataset, so the tracker suite still sees the canonical seed.
 */

async function register(
  page: Page,
  email: string,
  password: string,
  displayName?: string,
): Promise<void> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(email);
  if (displayName) await page.getByLabel(/Display name/).fill(displayName);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  // The tracker mounts only after the session is live.
  await expect(page.getByRole('button', { name: '+ New application' })).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: /Try demo/i })).toBeVisible();
}

test('an anonymous visitor lands on the sign-in screen; demo enters the seeded board', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Create account' })).toBeVisible();
  // No tracker behind the auth screen.
  await expect(page.getByRole('button', { name: '+ New application' })).toHaveCount(0);

  await page.getByRole('button', { name: /Try demo/i }).click();
  await expect(page.getByRole('region', { name: 'Wishlist column' })).toBeVisible();
  await expect(page.locator('.demo-badge')).toHaveText('demo');
  await expect(page.getByRole('button', { name: 'Reset demo' })).toBeVisible();
  const wishlist = page.getByRole('region', { name: 'Wishlist column' });
  await expect(wishlist.locator('article.card').first()).toBeVisible();
});

test('register → empty board → create → reload keeps the session and the card', async ({
  page,
}) => {
  const email = `e2e-alice-${Date.now()}@example.com`;
  const company = `Auth E2E ${Date.now()}`;
  await register(page, email, 'e2e-password-123', 'Alice E2E');

  // Fresh account: six columns, zero cards, no demo-reset button.
  await expect(page.getByRole('region', { name: 'Wishlist column' })).toBeVisible();
  await expect(page.locator('article.card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset demo' })).toHaveCount(0);
  await expect(page.locator('.user-name')).toHaveText('Alice E2E');

  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill('SRE');
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form).toBeHidden();
  await expect(page.locator('article.card', { hasText: company })).toBeVisible();

  // Session survives a reload (HttpOnly cookie, server-side session).
  await page.reload();
  await expect(page.locator('article.card', { hasText: company })).toBeVisible();
  await expect(page.locator('.user-name')).toHaveText('Alice E2E');
});

test('sign out → sign in returns to the same private board', async ({ page }) => {
  const email = `e2e-bob-${Date.now()}@example.com`;
  const company = `Bobs Card ${Date.now()}`;
  await register(page, email, 'e2e-password-456');

  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill('PM');
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form).toBeHidden();

  await signOut(page);
  // Signed out: the tracker is gone, data unreachable from the UI.
  await expect(page.locator('article.card')).toHaveCount(0);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('e2e-password-456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('article.card', { hasText: company })).toBeVisible();
});

test("a second account cannot see the first account's cards", async ({ page }) => {
  const stamp = Date.now();
  const company = `Private ${stamp}`;
  await register(page, `e2e-carol-${stamp}@example.com`, 'e2e-password-789');
  await page.getByRole('button', { name: '+ New application' }).click();
  const form = page.getByRole('dialog', { name: 'New application' });
  await form.getByPlaceholder('Acme Corp').fill(company);
  await form.getByPlaceholder('Frontend Engineer').fill('Data Engineer');
  await form.getByRole('button', { name: 'Create application' }).click();
  await expect(form).toBeHidden();
  await expect(page.locator('article.card', { hasText: company })).toBeVisible();
  await signOut(page);

  // A different account in the SAME browser: empty board, no leak.
  await register(page, `e2e-dave-${stamp}@example.com`, 'e2e-password-abc');
  await expect(page.locator('article.card')).toHaveCount(0);
  await page.getByLabel('Search applications').fill(company);
  await expect(page.locator('article.card')).toHaveCount(0);
});

test('wrong password shows an inline error and stays on the auth screen', async ({ page }) => {
  const email = `e2e-erin-${Date.now()}@example.com`;
  await register(page, email, 'e2e-password-def');
  await signOut(page);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('totally-wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password');
  await expect(page.getByRole('button', { name: /Try demo/i })).toBeVisible();
});
