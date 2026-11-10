import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`screenshot steering handoff ${mobile ? "mobile" : "desktop"}`, async ({ page }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("storybook-screenshot-submit", "Check **mobile** and *desktop* with `pnpm verify`."));
    await page.goto("/iframe.html?id=composer-steering-and-queued-messages--screenshot-submission&viewMode=story&globals=theme:light");
    const composer = page.getByTestId("queued-composer");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    // Attach real browser screenshots through the production file picker.
    const screenshot = await page.getByRole("main").screenshot();
    await page.route("**/api/attachments/*/content", route => route.fulfill({ contentType: "image/png", body: screenshot }));
    await composer.locator('input[type="file"]').setInputFiles([
      { name: "mobile.png", mimeType: "image/png", buffer: screenshot },
      { name: "desktop.png", mimeType: "image/png", buffer: screenshot },
    ]);
    await expect(composer.getByRole("button", { name: "Remove mobile.png" })).toBeEnabled();
    await expect(composer.getByRole("button", { name: "Remove desktop.png" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("before-submit.png"), fullPage: true });
    await composer.getByRole("button", { name: /^Send/ }).click();
    await expect(page.getByRole("button", { name: "Complete save" })).toBeVisible();
    const queue = page.getByTestId("task-chat-queued-messages");
    await expect(queue.locator("strong")).toHaveText("mobile");
    await expect(queue.locator("em")).toHaveText("desktop");
    await expect(queue.locator("code")).toHaveText("pnpm verify");
    await expect(queue.locator("img")).toHaveCount(2);
    await expect.poll(() => queue.locator("img").evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await queue.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll("img")].every(image => {
        const imageBounds = image.getBoundingClientRect();
        return imageBounds.top >= bounds.top && imageBounds.bottom <= bounds.bottom;
      });
    })).toBe(true);
    await expect(composer.getByTestId("task-chat-composer-images")).toHaveCount(0);
    await expect(composer.locator('[contenteditable="true"]')).toHaveText("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("save-pending.png"), fullPage: true });

    // A rejected save restores the same draft and screenshots for retry.
    await page.getByRole("button", { name: "Reject save" }).click();
    await expect(queue).toHaveCount(0);
    await expect(composer.getByTestId("task-chat-composer-images").locator("img")).toHaveCount(2);
    await expect(composer.locator("strong")).toContainText("mobile");
    await composer.getByRole("button", { name: /^Send/ }).click();
    await page.getByRole("button", { name: "Complete save" }).click();
    await expect(composer.getByTestId("task-chat-composer-images")).toHaveCount(0);
    await expect(queue.locator("img")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("save-complete.png"), fullPage: true });
    await queue.getByRole("button", { name: "Steer", exact: true }).click();
    await expect(queue).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("Message steered into the active turn.");
    expect(errors).toEqual([]);
  });
}

test("paragraphs and four screenshots fit beside narrow auto-send controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.clock.setFixedTime(new Date("2026-11-09T22:00:00Z"));
  await page.addInitScript(() => localStorage.setItem("storybook-screenshot-submit", "First paragraph.\n\nSecond paragraph."));
  await page.goto("/iframe.html?id=composer-steering-and-queued-messages--screenshot-submission&viewMode=story&args=autoSteer:true;mobile:true&globals=theme:light");
  const composer = page.getByTestId("queued-composer");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  const screenshot = await page.getByRole("main").screenshot();
  await page.route("**/api/attachments/*/content", route => route.fulfill({ contentType: "image/png", body: screenshot }));
  await composer.locator('input[type="file"]').setInputFiles([1, 2, 3, 4].map(index => ({
    name: `screen-${index}.png`, mimeType: "image/png", buffer: screenshot,
  })));
  await expect(composer.getByRole("button", { name: "Remove screen-4.png" })).toBeEnabled();
  await composer.getByRole("button", { name: /^Send/ }).click();
  const queue = page.getByTestId("task-chat-queued-messages");
  const first = queue.locator("p").filter({ hasText: "First paragraph." });
  const second = queue.locator("p").filter({ hasText: "Second paragraph." });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  expect(await first.evaluate(element => getComputedStyle(element).display)).toBe("block");
  expect(await first.evaluate(element => getComputedStyle(element).marginBottom)).toBe("0px");
  expect(await second.evaluate(element => getComputedStyle(element).marginTop)).toBe("0px");
  expect((await second.boundingBox())!.y).toBeGreaterThan((await first.boundingBox())!.y);
  await expect(queue.getByText("Sending in 5s")).toBeVisible();
  const images = queue.getByRole("group", { name: "Queued images" });
  await expect(images.locator("img")).toHaveCount(3);
  await expect.poll(() => images.locator("img").evaluateAll(nodes => nodes.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(images.getByText("+1")).toBeVisible();
  expect(await queue.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('[aria-label="Queued images"] > *, button, [data-testid^="task-chat-queued-auto-steer"]')].every(child => {
      const box = child.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("narrow-auto-steer.png"), fullPage: true });
});
