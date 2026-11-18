import { test, expect } from "@playwright/test";

const base = process.env.RECOVERY_STORYBOOK_URL;

test.describe("failed-attempt notice", () => {
  test.skip(!base, "Set RECOVERY_STORYBOOK_URL to an owned Storybook server.");

  for (const theme of ["light", "dark"]) {
    for (const width of [320, 1280]) {
      test(`readable failure and Retry at ${width}px in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 720 });
        await page.goto(`${base}/iframe.html?id=task-chat-recovery-notice--failed-in-conversation&viewMode=story&globals=theme:${theme}`);

        const notice = page.getByRole("status", { name: "Task status" });
        const icon = notice.locator('svg[aria-hidden="true"]');
        const message = notice.getByText("Couldn’t finish this attempt. Your message is saved.");
        const retry = notice.getByRole("button", { name: "Retry", exact: true });
        await expect(icon).toBeVisible();
        await expect(message).toBeVisible();
        await expect(retry).toBeVisible();

        const surface = await notice.evaluate(element => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat),
            topPadding: parseFloat(getComputedStyle(element.parentElement!).paddingTop),
          };
        });
        expect(surface.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(surface.padding.every(value => value > 0)).toBe(true);
        expect(surface.topPadding).toBeCloseTo(16);

        const iconBounds = (await icon.boundingBox())!;
        const textBounds = (await message.boundingBox())!;
        const retryBounds = (await retry.boundingBox())!;
        const iconCenter = iconBounds.y + iconBounds.height / 2;
        expect(iconCenter).toBeCloseTo(textBounds.y + textBounds.height / 2, 0);
        expect(iconCenter).toBeCloseTo(retryBounds.y + retryBounds.height / 2, 0);
        expect(textBounds.x + textBounds.width).toBeLessThanOrEqual(retryBounds.x);
        expect(retryBounds.x + retryBounds.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      });
    }
  }
});
