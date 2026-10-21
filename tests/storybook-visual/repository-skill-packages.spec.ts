import { expect, test } from '@playwright/test';

const story = (id: string) => `/iframe.html?id=skills-repository-packages--${id}&viewMode=story&globals=theme:dark`;

test('repository import preserves its files while selecting library entrypoints', async ({ page }, info) => {
  await page.goto(story('review-repository'));
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub', exact: true });
  await expect(dialog.getByRole('button', { name: 'Import repository', exact: true })).toBeEnabled();
  await expect(dialog.getByText('The full repository travels', { exact: false })).toHaveCount(0);
  await expect(dialog.getByText('4 of 4 selected', { exact: true })).toBeVisible();
  await expect(dialog.locator('summary').filter({ hasText: 'Choose skills' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'More import options', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Import individual skills', { exact: true })).toHaveCount(0);
  for (const path of ['SKILL.md', '.agents/skills/review/SKILL.md', '.agents/skills/review/security/SKILL.md', 'skills/research/SKILL.md']) {
    await expect(dialog.getByRole('checkbox', { name: `Import ${path}`, exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: `Import ${path}`, exact: true })).toBeChecked();
  }
  await expect(dialog.getByText('references', { exact: true })).not.toBeVisible();
  await expect(dialog.getByText('review.py', { exact: true })).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('repository-import.png') });

  await dialog.getByRole('button', { name: 'View 17 files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Included repository files', exact: true });
  await expect(files.getByRole('heading', { name: 'Runtime requirements', exact: true })).toBeVisible();
  await files.getByText('NOTICE.md', { exact: true }).first().click();
  await expect(files.getByText('Example upstream credits are preserved with this repository.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('repository-files.png') });
  await files.getByRole('button', { name: 'Close', exact: true }).click();

  await expect(dialog.getByText('Select whole skill packages.', { exact: false })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: 'Import skills/research/SKILL.md', exact: true }).uncheck();
  await expect(dialog.getByText('3 of 4 selected', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'View 17 files', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import repository', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
  await expect(source.getByText('Research', { exact: true })).toHaveCount(0);
});

test('omitted files warn without blocking import and warnings persist on the saved source', async ({ page }, info) => {
  await page.goto(story('import-with-warnings'));
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub', exact: true });
  const warning = dialog.getByLabel('Import warnings', { exact: true });
  await expect(warning.locator('summary')).toHaveText('2 import warnings');
  await expect(warning).not.toHaveAttribute('open');
  const action = dialog.getByRole('button', { name: 'Import repository', exact: true });
  await expect(action).toBeEnabled();
  await expect(dialog.getByText('Invalid', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('repository-warnings.png') });
  await warning.locator('summary').click();
  await expect(warning).toContainText('shared/tools');
  await expect(warning).toContainText('assets/demo.mov');
  await page.screenshot({ path: info.outputPath('repository-warning-details.png') });
  await action.click();
  await expect(dialog).not.toBeVisible();
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
  await expect(source.getByRole('status')).toHaveCount(0);
  const savedWarning = source.getByLabel('Import warnings', { exact: true });
  await expect(savedWarning.locator('summary')).toHaveText('2 import warnings');
  await savedWarning.locator('summary').click();
  await expect(savedWarning).toContainText('shared/tools');
});

test('missing references warn without adding repair controls', async ({ page }, info) => {
  await page.goto(story('missing-file'));
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub', exact: true });
  const warning = dialog.getByLabel('Import warnings', { exact: true });
  await expect(warning.locator('summary')).toHaveText('1 import warning');
  await warning.locator('summary').click();
  await expect(warning).toContainText('references/threat-model.md');
  await expect(dialog.getByRole('button', { name: 'Add file', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Import repository', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('repository-missing-file.png') });
  await dialog.getByRole('button', { name: 'Import repository', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'acme/team-skills', exact: true }).getByText('Security review', { exact: true })).toBeVisible();
});

test('skills needing setup remain selected and do not block the repository', async ({ page }, info) => {
  await page.goto(story('skill-needs-setup'));
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub', exact: true });
  await expect(dialog.getByRole('checkbox', { name: 'Import experimental/deploy/SKILL.md', exact: true })).toBeChecked();
  await expect(dialog.getByText('Needs setup', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import repository', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('repository-needs-setup.png') });
});

test('the import action stays visible on mobile with all skills shown', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(story('mobile'));
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub', exact: true });
  const button = dialog.getByRole('button', { name: 'Import repository', exact: true });
  await expect(button).toBeEnabled();
  const bounds = await button.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(812);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: info.outputPath('repository-mobile.png') });
});
