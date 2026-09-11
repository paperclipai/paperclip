import { expect, test } from "@playwright/test";

const storyIds = [
  "product-issue-management--issue-properties-relationship-badges",
  "product-issue-management--issue-properties-relationship-badges-inline",
];

for (const storyId of storyIds) {
  test(`${storyId} stays still until an operator acts`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${storyId}&viewMode=story&globals=theme:dark`);
    const remove = page.getByRole("button", { name: "Remove PAP-18313 as blocker", exact: true });
    await expect(remove).toBeAttached();

    // Sample successive painted frames, not just the settled end state: an
    // autoplay remove/reset cycle would otherwise leave an identical screenshot.
    const frames = await page.evaluate(async () => {
      const samples = [];
      for (let frame = 0; frame < 60; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const button = document.querySelector('button[aria-label="Remove PAP-18313 as blocker"]');
        const link = button?.previousElementSibling;
        samples.push({
          route: document.querySelector('[data-testid="relationship-route"]')?.textContent,
          opacity: button ? getComputedStyle(button).opacity : null,
          badge: link?.getBoundingClientRect().toJSON() ?? null,
        });
      }
      return samples;
    });
    expect(frames[0].route).toBe("/PAP/storybook");
    expect(frames[0].opacity).toBe("0");
    expect(frames[0].badge).not.toBeNull();
    for (const frame of frames) expect(frame).toEqual(frames[0]);

    const link = page.getByRole("link", { name: "Task PAP-18313: Review task relationships", exact: true }).first();
    const before = await link.boundingBox();
    await link.hover();
    await expect(remove).toHaveCSS("opacity", "1");
    expect(await link.boundingBox()).toEqual(before);
    const textRight = await link.locator("span").evaluate((element) => element.getBoundingClientRect().right);
    expect(textRight).toBeLessThan((await remove.boundingBox())!.x);

    await link.getByRole("img", { name: "Todo" }).click();
    await expect(page.getByTestId("relationship-route")).toHaveText("/PAP/issues/PAP-18313");
    await expect(remove).toBeAttached();
    await page.keyboard.press("Tab");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Space");
    await expect(remove).not.toBeAttached();
    await expect(page.getByRole("button", { name: "Remove PAP-18314 as blocker" })).toBeAttached();
    await expect(page.getByTestId("relationship-route")).toHaveText("/PAP/issues/PAP-18313");
  });
}

test("switching relationship previews never runs removal or navigation", async ({ page }) => {
  await page.goto(`/?path=/story/${storyIds[0]}`);
  const preview = page.frameLocator("#storybook-preview-iframe");
  for (const name of [
    "IssueProperties - relationship badges inline",
    "IssueProperties - relationship badges",
    "IssueProperties - relationship badges inline",
  ]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(preview.getByRole("button", { name: "Remove PAP-18313 as blocker" })).toBeAttached();
    await expect(preview.getByTestId("relationship-route")).toHaveText("/PAP/storybook");
    await expect(preview.getByRole("button", { name: "Remove PAP-18314 as blocker" })).toBeAttached();
  }
});
