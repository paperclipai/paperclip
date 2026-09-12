import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

const index = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../ui/storybook-static/index.json"), "utf8"));
const stories = Object.values(index.entries).filter((entry: any) => entry.id.startsWith("connections-imessage-photon--")) as { id: string; name: string }[];
for (const story of stories) for (const theme of ["light", "dark"]) {
  test(`${story.name} / ${theme}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: /Narrow/.test(story.name) ? 390 : 1200, height: 844 });
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
    await page.waitForFunction((id) => document.body.dataset.photonStoryReady === id || document.body.dataset.photonStoryError, story.id);
    expect(await page.locator("body").getAttribute("data-photon-story-error")).toBeNull();
    await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
    await expect(page.getByText("Simulated Photon demo.", { exact: true })).toBeVisible();
    if (/incoming-follow-ups|narrow-mobile/.test(story.id)) {
      await expect(page.getByText("Sent from iMessage", { exact: false })).toHaveCount(2);
    }
    if (story.id.endsWith("shared-dm-walkthrough")) {
      await expect(page.getByRole("heading", { name: "DEMO-1 · Launch plan" })).toBeVisible();
      await expect(page.getByText("Sent from iMessage", { exact: false })).toBeVisible();
    }
    if (story.id.endsWith("multiple-dedicated-numbers")) {
      await expect(page.getByRole("radio", { name: "+15555550112" })).toBeChecked();
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${story.id}-${theme}.png`), fullPage: true, animations: "disabled" });
  });
}
