import { expect, test } from '@playwright/test';

const story = (name: string) => `/iframe.html?id=skills-project-repository-skills-02-journeys--${name}&viewMode=story&globals=theme:dark`;

test('groups matching project repositories and keeps progress visible through adoption', async ({ page }) => {
  await page.goto(story('duplicate-projects'));
  await expect(page.getByRole('button', { name: 'Import skills', exact: true })).toHaveCount(1);
  await expect(page.getByText('Acme platform, Sentry · main', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import skills', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Starting import');
  await expect(page.getByRole('region', { name: 'acme/team-skills', exact: true }).getByText('Code review', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import skills', exact: true })).toHaveCount(0);
});

test('keeps an existing source compact while allowing project import from its menu', async ({ page }, info) => {
  await page.goto(story('existing-source-more-projects'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByRole('link', { name: 'acme/team-skills', exact: true })).toHaveCount(1);
  await expect(source).not.toContainText('Paperclip Cloud');
  await expect(source).not.toContainText('Sentry');
  await expect(source).not.toContainText('Other projects with this repo');
  await expect(page.getByRole('link', { name: 'Installed skills', exact: true })).toHaveCount(0);
  await expect(source.getByRole('button', { name: 'Import skills', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('existing-source-more-projects.png') });
  await source.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import project skills', exact: true }).click();
  await expect(source.getByRole('status')).toContainText('Importing skills');
  await expect(source.getByRole('status')).toHaveCount(0);
  await source.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^(Import (remaining )?project skills|Retry project import)$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(source).toBeVisible();
  await expect(source).not.toContainText('Paperclip Cloud');
  await expect(source).not.toContainText('Sentry');
});

test('repairs a missing branch without prompting for another connection', async ({ page }) => {
  await page.goto(story('missing-branch'));
  await expect(page.getByRole('button', { name: 'Choose connection', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose a new branch', exact: true }).click();
  await page.getByRole('combobox', { name: 'Branch', exact: true }).click();
  await page.getByRole('option', { name: 'master Default', exact: true }).click();
  await page.getByRole('button', { name: 'Change branch', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/master · Updated/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'acme/team-skills', exact: true }).getByText('Code review', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true })).toBeFocused();
});

test('creating a project imports repository skills without another setup flow', async ({ page }) => {
  await page.goto(story('create-project'));
  await page.getByRole('button', { name: 'Add Project', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create project', exact: true });
  await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('Repository project');
  await dialog.getByRole('button', { name: 'Add GitHub repo', exact: true }).click();
  await page.getByRole('option', { name: 'acme/team-skills My GitHub account · Acme engineering', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await page.getByLabel('Skills', { exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import skills', exact: true })).toHaveCount(0);
});

test('attaching another repository imports skills and keeps the original source', async ({ page }) => {
  await page.goto(story('attach-repository'));
  await page.getByRole('button', { name: 'Add another repo', exact: true }).click();
  await page.getByRole('option', { name: 'maya/research-skills My GitHub account', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await page.getByLabel('Skills', { exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
  const original = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  const added = page.getByRole('region', { name: 'maya/research-skills', exact: true });
  await expect(original.getByText('Code review', { exact: true })).toBeVisible();
  await expect(added.getByText('Code review', { exact: true })).toBeVisible();
  expect(await original.getByRole('link', { name: /^Code review / }).getAttribute('href'))
    .not.toBe(await added.getByRole('link', { name: /^Code review / }).getAttribute('href'));
});

test('empty repositories explain automatic discovery of future skills', async ({ page }) => {
  await page.goto(story('empty-repository'));
  await expect(page.getByText('No skills found yet. New skills will be imported automatically.', { exact: true })).toBeVisible();
});

test('routine instructions stay stable while new executions follow updated skill content', async ({ page }) => {
  await page.goto(story('routine-reference'));
  const description = page.getByRole('region', { name: 'Description', exact: true });
  await expect(description.getByRole('link', { name: '/code-review', exact: true })).toBeVisible();
  const instructions = await description.innerText();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('button', { name: 'Run routine', exact: true }).click();
  await page.getByRole('link', { name: 'Open PAP-124: Review project changes', exact: true }).click();
  const outcome = page.getByText(/^Completed using code review version /);
  await expect(outcome).toContainText('version-entry-1 at commit a17d36');
  await expect(outcome).toBeVisible();
  const first = await outcome.textContent() ?? '';
  expect(first).toContain('version-entry-1 at commit a17d36');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await page.getByLabel('Skills', { exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
  await page.getByRole('region', { name: 'acme/team-skills', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Security review', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Routines', exact: true }).click();
  await page.getByRole('main').getByText('Review project changes', { exact: true }).click();
  await page.getByLabel('Routine navigation', { exact: true }).getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(description).toHaveText(instructions, { useInnerText: true });
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByRole('button', { name: 'Run routine', exact: true }).click();
  await page.getByRole('link', { name: 'Open PAP-125: Review project changes', exact: true }).click();
  await expect(outcome).toContainText('version-entry-1-updated at commit bbbbbbbb');
  await page.getByRole('link', { name: 'Routine', exact: true }).click();
  await page.getByLabel('Routine navigation', { exact: true }).getByRole('link', { name: 'Runs', exact: true }).click();
  await page.getByRole('link', { name: 'Open PAP-124: Review project changes', exact: true }).click();
  await expect(outcome).toHaveText(first);
});

test('legacy adoption imports directly and survives navigation within the journey', async ({ page }, info) => {
  await page.goto(story('legacy-adoption'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  const action = page.getByRole('button', { name: 'Import skills', exact: true });
  await action.click();
  await expect(source).toBeVisible();
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
  await expect(action).toHaveCount(0);
  await page.getByLabel('Skills', { exact: true }).getByRole('link', { name: 'Installed', exact: true }).click();
  await expect(source).toHaveCount(0);
  await expect(page.getByText('Code review', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Skills', { exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(source).toBeVisible();
  await page.screenshot({ path: info.outputPath('legacy-adopted.png') });
});

test('background refresh imports an addition without clicking refresh', async ({ page }, info) => {
  await page.goto(story('automatic-update'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByText('Security review', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(source.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('automatic-update.png') });
});

test('keeps GitHub connection management in the page actions menu', async ({ page }) => {
  await page.goto(story('synced'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByRole('link', { name: 'Manage GitHub connection', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'More source actions', exact: true }).click();
  const manageConnection = page.getByRole('menuitem', { name: 'Manage GitHub connection', exact: true });
  await expect(manageConnection).toBeVisible();
  await expect(manageConnection).toHaveAttribute('href', /\/apps$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'More source actions', exact: true })).toBeFocused();
});

test('refresh failure retains content and retry recovers', async ({ page }, info) => {
  await page.goto(story('failed-refresh'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
  await expect(source.getByRole('alert')).toContainText('installed skills were kept');
  await page.screenshot({ path: info.outputPath('refresh-error.png') });
  await source.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(source.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await source.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(source.getByText('Security review', { exact: true })).toBeVisible();
  await expect(source.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('refresh-recovered.png') });
});

test('automatic update preference is accessible and changes in place', async ({ page }) => {
  await page.goto(story('synced'));
  await page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  const toggle = page.getByRole('menuitemcheckbox', { name: 'Automatic updates', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.getByText('Automatic updates paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true })).toBeFocused();
});

test('mobile touch actions stay usable without horizontal overflow', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await page.goto(story('mobile'));
    await expect(page.getByRole('heading', { name: 'Skill sources', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).tap();
    await page.getByRole('menuitemcheckbox', { name: 'Automatic updates', exact: true }).tap();
    await expect(page.getByText('Automatic updates paused', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('sources-mobile.png') });
  } finally { await context.close(); }
});

test('connection repair keeps the installed skills and selections', async ({ page }) => {
  await page.goto(story('connection-repair'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await source.getByRole('button', { name: 'Choose connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: 'My GitHub account', exact: true })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save connection', exact: true })).toBeEnabled();
  await dialog.getByRole('radio', { name: 'My GitHub account', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(source.getByRole('button', { name: 'More actions for acme/team-skills', exact: true })).toBeFocused();
  await expect(source.getByRole('alert')).toHaveCount(0);
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
});

test('connection repair recovers from a concurrent update without losing the selected account', async ({ page }) => {
  await page.goto(story('repair-conflict'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await source.getByRole('button', { name: 'Choose connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const account = dialog.getByRole('radio', { name: 'My GitHub account', exact: true });
  await account.click();
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('This source was updated');
  await expect(account).toBeChecked();
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(source.getByRole('alert')).toHaveCount(0);
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
});

test('keeping project skill copies explains retained access and removes tracking', async ({ page }) => {
  await page.goto(story('private-project'));
  await page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Disconnect source', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect acme/team-skills?', exact: true });
  await expect(dialog.getByRole('button', { name: 'Disconnect source', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Move them to My Skills, keeping project access restrictions. Assigned agents keep using them.', { exact: true })).toBeVisible();
  await dialog.getByRole('radio', { name: /Keep editable copies/ }).click();
  await dialog.getByRole('button', { name: 'Disconnect source', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'acme/team-skills', exact: true })).toHaveCount(0);
});

test('cancelling source removal keeps tracking and allows refresh', async ({ page }) => {
  await page.goto(story('synced'));
  await page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Disconnect source', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect acme/team-skills?', exact: true });
  await dialog.getByRole('radio', { name: /Delete skills/ }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await source.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(source.getByText('Security review', { exact: true })).toBeVisible();
});


test('withdrawn setup requests remain terminal on a narrow light layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/iframe.html?id=connections-in-task-connections--ai-withdrawn&viewMode=story&globals=theme:light');
  await expect(page.getByTestId('connection-intent-terminal')).toBeVisible();
  await expect(page.getByText('Connection request withdrawn', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix connection', exact: true })).toHaveCount(0);
});
