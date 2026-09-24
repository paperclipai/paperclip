import { expect, type Locator } from "@playwright/test";

/** Controlled settings switches update after their asynchronous save handler. */
export async function setSettingsToggle(toggle: Locator, enabled: boolean) {
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-checked") !== String(enabled)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
}
