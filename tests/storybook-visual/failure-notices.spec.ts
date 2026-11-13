import { expect, test } from "@playwright/test";

const stories = [
  "failed-run", "older-marker", "production-mode", "recovery-is-latest",
  "failure-is-latest", "expanded-recovery-and-retry", "expanded-failure-and-retry",
  "message-between-errors", "system-notice-between-errors", "production-system-notice-between-errors",
  "light", "mobile", "legacy-run-retry", "legacy-production-retry",
  "automatic-recovery-blocked", "production-automatic-recovery-blocked",
];

for (const theme of ["dark", "light"]) {
  for (const story of stories) {
    test(`${story} [${theme}]`, async ({ page }, testInfo) => {
      if (story === "mobile") await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const id = `tasks-failure-notices--${story}`;
      await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
      // Storybook records this after play assertions and accessibility reports.
      await expect.poll(() => page.evaluate(() => {
        const channel = (window as unknown as {
          __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ storyId?: string; status?: string }>> };
        }).__STORYBOOK_ADDONS_CHANNEL__;
        return channel?.data.storyFinished?.[0]?.status;
      })).toBe("success");
      expect(await page.evaluate(() => (window as unknown as {
        __STORYBOOK_ADDONS_CHANNEL__: { data: Record<string, unknown> };
      }).__STORYBOOK_ADDONS_CHANNEL__.data.playFunctionThrewException)).toBeUndefined();
      expect(errors).toEqual([]);
      await expect(page.locator("body.sb-show-errordisplay, main .border-dashed, main .h-px")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (["recovery-is-latest", "failure-is-latest", "light", "mobile"].includes(story)) {
        await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
        await expect(page.getByText(story === "failure-is-latest" ? "No live execution path" : "Run failed", { exact: true })).toHaveCount(0);
      }
      if (["expanded-recovery-and-retry", "automatic-recovery-blocked", "production-automatic-recovery-blocked"].includes(story)) {
        await expect(page.getByRole("status")).toHaveText("Recovery retry requested");
      }
      if (["legacy-run-retry", "legacy-production-retry"].includes(story)) {
        await expect(page.getByRole("status")).toHaveText("Retry requested for failed-run");
        await expect(page.getByText("Run failed", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
      }
      if (story === "expanded-failure-and-retry") {
        await expect(page.getByRole("status")).toHaveText("Retry requested for failed-run");
        await expect(page.getByRole("link", { name: "View run" })).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath(`${story}-${theme}.png`), fullPage: true });
    });
  }
}
