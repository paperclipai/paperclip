import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  for (const width of [390, 1200]) {
    for (const story of ["inline-patch", "markdown-card", "attachment-tab", "workspace-tab", "document"]) {
      test(`${story} ${theme} ${width}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`/iframe.html?id=documents-patch-preview--${story}&viewMode=story&globals=theme:${theme}`);
        const finished = () => page.evaluate(() => (window as unknown as {
          __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> };
        }).__STORYBOOK_ADDONS_CHANNEL__?.data.storyFinished?.[0]?.status);
        await expect.poll(finished, { timeout: 30_000 }).not.toBeUndefined();
        expect(await finished()).toBe("success");
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const added = page.locator('[data-patch-line="add"]').first();
        const removed = page.locator('[data-patch-line="remove"]').first();
        await expect(added).toBeVisible();
        await expect(removed).toBeVisible();
        const colors = await Promise.all([added, removed].map((line) => line.evaluate((node) => ({
          color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor,
        }))));
        expect(colors[0].color).not.toBe(colors[1].color);
        expect(colors[0].background).not.toBe(colors[1].background);
        for (const pre of await page.locator("main pre").all()) {
          expect(await pre.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        }
        await expect(page.locator("main script")).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath(`${story}-${theme}-${width}.png`), fullPage: true });
      });
    }
  }
}
