import { expect, test, type Page } from '@playwright/test';

const story = (name = 'choose-branch', theme = 'dark') => `/iframe.html?id=skills-project-repository-skills-04-branch-selection-journeys--${name}&viewMode=story&globals=theme:${theme}`;

async function openRepair(page: Page) {
  await page.getByRole('button', { name: 'Choose a new branch', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a new branch', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function search(page: Page, name: string) {
  const picker = page.getByRole('combobox', { name: 'Branch', exact: true });
  if (await picker.getAttribute('aria-expanded') !== 'true') await picker.click();
  await page.getByPlaceholder('Search or enter a branch name…', { exact: true }).fill(name);
}

test('marks the default branch and saves a searched listed branch without replacing skills', async ({ page }) => {
  await page.goto(story());
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  const skill = source.getByRole('link', { name: /^Code review / });
  const skillHref = await skill.getAttribute('href');
  const dialog = await openRepair(page);
  await expect(dialog.getByRole('button', { name: 'Change branch', exact: true })).toBeDisabled();
  await search(page, '');
  await expect(page.getByRole('option', { name: 'master Default', exact: true })).toBeVisible();
  await search(page, 'release');
  await page.getByRole('option', { name: 'release/2026.10', exact: true }).click();
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Changing branch…', exact: true })).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  await expect(source.getByText(/release\/2026\.10 · Updated/)).toBeVisible();
  await expect(skill).toHaveAttribute('href', skillHref!);
  await expect(page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true })).toBeFocused();
});

test('allows an unlisted branch while discovery is still loading', async ({ page }) => {
  await page.goto(story('slow-branch-list'));
  const dialog = await openRepair(page);
  await expect(dialog.getByRole('status')).toContainText('Loading branches');
  await search(page, 'feature/not-in-the-list');
  await page.getByRole('option', { name: 'Use “feature/not-in-the-list”', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Branch', exact: true })).toContainText('feature/not-in-the-list');
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/feature\/not-in-the-list · Updated/)).toBeVisible();
});

test('retains manual entry when discovery fails', async ({ page }) => {
  await page.goto(story('branch-list-unavailable'));
  const dialog = await openRepair(page);
  await expect(dialog.getByRole('alert')).toContainText('You can still enter a branch name');
  await search(page, 'private/release');
  await page.getByRole('option', { name: 'Use “private/release”', exact: true }).click();
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/private\/release · Updated/)).toBeVisible();
});

test('retries discovery and loads the default branch', async ({ page }) => {
  await page.goto(story('branch-list-unavailable'));
  const dialog = await openRepair(page);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await search(page, 'master');
  await page.getByRole('option', { name: 'master Default', exact: true }).click();
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(page.getByText(/master · Updated/)).toBeVisible();
});

test('keeps an invalid selection and permits correction after a save error', async ({ page }) => {
  await page.goto(story('validation-failure'));
  const dialog = await openRepair(page);
  await search(page, 'feature/missing');
  await page.getByRole('option', { name: 'Use “feature/missing”', exact: true }).click();
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('GitHub could not find that branch or revision');
  await expect(dialog.getByRole('combobox', { name: 'Branch', exact: true })).toContainText('feature/missing');
  await expect(page.getByText(/main · Updated/)).toBeVisible();
  await search(page, 'master');
  await page.getByRole('option', { name: 'master Default', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/master · Updated/)).toBeVisible();
});

test('keyboard input accepts an unlisted branch and Escape closes only the picker', async ({ page }) => {
  await page.goto(story('empty-branch-list'));
  const dialog = await openRepair(page);
  await search(page, 'feature/keyboard');
  const input = page.getByPlaceholder('Search or enter a branch name…', { exact: true });
  await input.press('Escape');
  await expect(dialog).toBeVisible();
  await search(page, 'feature/keyboard');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(dialog.getByRole('combobox', { name: 'Branch', exact: true })).toContainText('feature/keyboard');
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/feature\/keyboard · Updated/)).toBeVisible();
});

test('cancel preserves the tracked branch and clears the next draft', async ({ page }) => {
  await page.goto(story());
  const dialog = await openRepair(page);
  await search(page, 'master');
  await page.getByRole('option', { name: 'master Default', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/main · Updated/)).toBeVisible();
  await openRepair(page);
  await expect(dialog.getByRole('combobox', { name: 'Branch', exact: true })).toContainText('Choose a branch');
  await expect(dialog.getByRole('button', { name: 'Change branch', exact: true })).toBeDisabled();
});

test('retains a selection across a concurrent source update and retries with the new revision', async ({ page }) => {
  await page.goto(story('save-conflict'));
  const dialog = await openRepair(page);
  await search(page, 'master');
  await page.getByRole('option', { name: 'master Default', exact: true }).click();
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your branch is still selected');
  await expect(dialog.getByRole('combobox', { name: 'Branch', exact: true })).toContainText('master');
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/master · Updated/)).toBeVisible();
});

test('uses the selected connection when repairing an unavailable branch', async ({ page }) => {
  await page.goto(story('connection-repair'));
  await page.getByRole('button', { name: 'Choose connection', exact: true }).click();
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a new branch', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a new branch', exact: true });
  await search(page, 'master');
  await page.getByRole('option', { name: 'master Default', exact: true }).click();
  await dialog.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Choose GitHub connection', exact: true })).toHaveCount(0);
  await expect(page.getByText(/master · Updated/)).toBeVisible();
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('selects a long typed branch using touch without horizontal overflow', async ({ page }) => {
    await page.goto(story('choose-branch', 'light'));
    await page.getByRole('button', { name: 'Choose a new branch', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'Choose a new branch', exact: true });
    const branch = 'feature/platform-services-new-skill-refresh-and-accessibility';
    await search(page, branch);
    await page.getByRole('option', { name: `Use “${branch}”`, exact: true }).tap();
    await expect(dialog.getByRole('button', { name: 'Change branch', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Change branch', exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(new RegExp(`${branch} · Updated`))).toBeVisible();
  });
});
