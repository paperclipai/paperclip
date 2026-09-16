import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
const index = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../ui/storybook-static/index.json'), 'utf8'));
const stories = Object.values(index.entries).filter((entry: any) => entry.id.startsWith('connections-in-task-connections--')) as { id: string; name: string }[];
for (const story of stories) for (const theme of ['light', 'dark']) {
  test(`${story.name} / ${theme}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: /Narrow/.test(story.name) ? 390 : 1200, height: 844 });
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
    await page.waitForFunction(() => document.body.classList.contains('sb-show-main') || document.body.classList.contains('sb-show-errordisplay'));
    await expect(page.locator('.sb-errordisplay')).not.toBeVisible();
    await page.waitForFunction((id) => document.body.dataset.inFeedStoryReady === id, story.id);
    expect(await page.locator("body").getAttribute("data-in-feed-story-error")).toBeNull();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all(Array.from(document.images).map((image) => image.decode().catch(() => {}))));
    if (story.id.endsWith('reuse-and-return-focus')) {
      await expect(page.getByText('Notion connected', { exact: true })).toBeVisible();
      await expect(page.getByTestId('connection-intent-focus-target')).toBeFocused();
    }
    if (story.id.endsWith('pending-with-composer')) await expect(page.getByRole('textbox')).toContainText('While I connect');
    if (story.id.endsWith('resolution-error')) await expect(page.getByRole('note')).toContainText('no permitted tools');
    if (story.id.endsWith('permission-denied')) await expect(page.getByRole('note')).toContainText('no longer have permission');
    if (story.id.endsWith('scrollable-connections')) {
      await page.getByRole('button', { name: 'Connect new', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Connect new', exact: true })).toBeVisible();
    }
    await expect.poll(() => errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${story.id}-${theme}.png`), fullPage: true, animations: 'disabled' });
  });
}
test('keyboard opens and closes setup, preserves the composer, and validates personal default', async ({ page }) => {
  await page.goto('/iframe.html?id=connections-in-task-connections--pending-with-composer&viewMode=story');
  await page.waitForFunction(() => document.body.dataset.inFeedStoryReady === 'connections-in-task-connections--pending-with-composer');
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await connect.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Just me', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('textbox')).toBeEditable();
  await expect(page.getByTestId('connection-intent-focus-target')).toBeFocused();
});
