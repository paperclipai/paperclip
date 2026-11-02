import { test, expect } from "@playwright/test";

test.skip(!process.env.HIRING_AI_STORYBOOK_URL, "Set HIRING_AI_STORYBOOK_URL to the isolated Storybook server");
for (const name of ["new-claude-connection", "new-codex-connection", "new-codex-connection-narrow", "new-claude-api-connection", "new-codex-connection-complete", "ai-repair-cancel", "ai-repair-invalid-key"]) {
  test(`storybook: ${name}`, async ({ page }, testInfo) => {
    if (name.endsWith("narrow")) await page.setViewportSize({ width: 375, height: 812 });
    const id = `connections-in-task-connections--${name}`;
    await page.goto(`${process.env.HIRING_AI_STORYBOOK_URL}/iframe.html?id=${id}&viewMode=story`);
    await expect.poll(() => page.evaluate(() => document.body.dataset.inFeedStoryReady), { timeout: 60_000 }).toBe(id);
    expect(await page.evaluate(() => document.body.dataset.inFeedStoryError)).toBeUndefined();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  });
}
