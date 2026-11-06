import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  for (const story of ["pap-2525", "mobile", "classic", "mixed-results", "single-image", "unavailable-image", "streaming-results", "gallery", "production-feed"]) {
    test(`${story} [${theme}]`, async ({ page }, testInfo) => {
      if (story === "mobile") await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`/iframe.html?id=task-chat-feed-image-grids--${story}&viewMode=story&globals=theme:${theme}`);
      await expect(page.getByTestId("task-chat-image-grid").first()).toBeVisible({ timeout: 60000 });
      await expect.poll(() => page.evaluate(() => {
        const channel = (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> } }).__STORYBOOK_ADDONS_CHANNEL__;
        return channel?.data.storyFinished?.[0]?.status;
      }), { timeout: 30000 }).toBeDefined();
      const report = await page.evaluate(() => {
        const channel = (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__: { data: {
          playFunctionThrewException?: unknown;
          storyFinished?: Array<{ status?: string; reporters?: Array<{ result?: { violations?: Array<{ id: string; nodes: Array<{ failureSummary: string }> }> } }> }>;
        } } }).__STORYBOOK_ADDONS_CHANNEL__;
        const result = channel.data.storyFinished?.[0];
        return { status: result?.status, exception: channel.data.playFunctionThrewException,
          violations: result?.reporters?.flatMap((r) => r.result?.violations?.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.failureSummary) })) ?? []) };
      });
      expect(report.status, JSON.stringify(report)).toBe("success");
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const grid = page.getByTestId("task-chat-image-grid").first();
      if (story === "single-image" || story === "unavailable-image") await expect(grid.getByRole("button")).toHaveCount(1);
      if (story === "mixed-results") await expect(page.getByTestId("task-chat-image-grid")).toHaveCount(2);
      if (["pap-2525", "mobile", "classic", "production-feed", "streaming-results"].includes(story)) {
        await expect(grid.getByRole("button")).toHaveCount(7);
        const tiles = grid.getByRole("button");
        const first = await tiles.nth(0).boundingBox();
        const second = await tiles.nth(1).boundingBox();
        expect(second!.y).toBe(first!.y);
        expect(second!.x).toBeGreaterThan(first!.x);
        expect(first!.width).toBeLessThan(200);
        // Desktop uses four columns; mobile wraps to two and fits the viewport.
        expect(await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(story === "mobile" ? 2 : 4);
      }
      if (story !== "unavailable-image") {
        for (const img of await page.locator('[data-testid="task-chat-image-grid"] img').all()) {
          await img.scrollIntoViewIfNeeded();
          await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
        }
      } else {
        await expect(grid.locator("img")).toHaveCount(0);
        await expect(grid.getByText("Image", { exact: true }).first()).toBeVisible();
      }
      if (story === "production-feed") await expect(page.getByText(/^Prepared .* for this response\.$/)).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: testInfo.outputPath(`${story}-${theme}.png`), fullPage: true });
    });
  }
}
