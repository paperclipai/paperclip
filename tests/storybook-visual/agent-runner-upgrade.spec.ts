import { expect, test } from "@playwright/test";

const stories = ["legacy-codex", "legacy-claude", "upgrade-codex", "upgrade-claude", "upgrading",
  "failure-and-retry", "incompatible-claude-setting", "repair-and-upgrade", "already-upgraded",
  "unavailable-environment", "agent-running", "mobile", "light"];

for (const theme of ["dark", "light"]) {
  for (const story of stories) {
    test(`${story} [${theme}]`, async ({ page }, testInfo) => {
      if (story === "mobile") await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const interactive = ["upgrade-codex", "upgrade-claude", "upgrading", "failure-and-retry", "incompatible-claude-setting", "repair-and-upgrade"].includes(story);
      await page.goto(interactive
        ? `/?path=/story/agents-runner-upgrade--${story}&globals=theme:${theme}`
        : `/iframe.html?id=agents-runner-upgrade--${story}&viewMode=story&globals=theme:${theme}`);
      const main = interactive ? page.frameLocator("#storybook-preview-iframe").getByRole("main") : page.getByRole("main");
      await expect(main.getByRole("button", { name: "Model", exact: true })).toBeVisible({ timeout: 20_000 });
      if (interactive) {
        await page.getByRole("tab", { name: /^Interactions/ }).click();
        await expect(page.getByRole("tabpanel", { name: /^Interactions/ }).getByText("Pass", { exact: true })).toBeVisible({ timeout: 20_000 });
      }
      if (["upgrade-codex", "upgrade-claude", "failure-and-retry", "repair-and-upgrade"].includes(story)) {
        await expect(main.getByText("Upgraded to Paperclip Runner.", { exact: true })).toBeVisible();
        await expect(main.getByRole("button", { name: "Upgrade runner", exact: true })).toHaveCount(0);
      } else if (["already-upgraded", "unavailable-environment"].includes(story)) {
        await expect(main.getByText("Upgrade to Paperclip Runner", { exact: true })).toHaveCount(0);
      } else if (story === "upgrading") {
        await expect(main.getByRole("button", { name: "Upgrading…", exact: true })).toBeDisabled();
      } else {
        await expect(main.getByRole("button", { name: "Upgrade runner", exact: true })).toBeEnabled();
      }
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const path = testInfo.outputPath(`${story}-${theme}.png`);
      if (interactive) await page.locator("#storybook-preview-iframe").screenshot({ path });
      else await page.screenshot({ path, fullPage: true });
    });
  }
}
