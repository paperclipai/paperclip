import { expect, test } from "@playwright/test";

const prefix = "pr-reviews-fireflies-and-app-webhooks--";
test("every PR surface renders and completes its Storybook interactions", async ({ browser, request }) => {
  const index = await (await request.get("/index.json")).json();
  const stories = Object.values(index.entries as Record<string, { id: string; type: string }>).filter((entry) => entry.id.startsWith(prefix) && entry.type === "story");
  expect(stories).toHaveLength(27);
  const page = await browser.newPage();
  for (const story of stories) {
    await test.step(story.id, async () => {
      const errors: string[] = [];
      const record = (error: Error) => errors.push(error.message);
      page.on("pageerror", record);
      await page.goto(`http://127.0.0.1:6149/iframe.html?id=${story.id}&viewMode=story`);
      await page.waitForFunction((id) => document.body.dataset.firefliesStoryReady === id || !!document.body.dataset.firefliesStoryError, story.id);
      expect(await page.locator("body").getAttribute("data-fireflies-story-error")).toBeNull();
      expect(errors).toEqual([]);
      await expect(page.locator("#storybook-root")).not.toBeEmpty();
      page.off("pageerror", record);
    });
  }
  await page.close();
});

test("mobile setup keeps the new key and its footer reachable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/iframe.html?id=${prefix}mobile-setup&viewMode=story`);
  await expect(page.getByRole("button", { name: "Copy Secret key", exact: true })).toBeVisible();
  const finish = page.getByRole("button", { name: "Finish without testing", exact: true });
  await finish.scrollIntoViewIfNeeded();
  await expect(finish).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await finish.click();
  await expect(page.getByText(/No webhook was saved/)).toBeVisible();
});
