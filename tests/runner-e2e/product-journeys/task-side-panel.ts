import { expect, type Page } from "@playwright/test";

export async function openTaskSidePanel(page: Page, ready: () => Promise<boolean>) {
  if (await ready()) return;
  const toggle = page.getByRole("button", { name: "Toggle side panel", exact: true, pressed: false }).filter({ visible: true }).first();
  const legacy = page.getByRole("button", { name: /^(Show properties|Properties)$/ }).filter({ visible: true }).first();
  await expect.poll(async () => await ready() || await toggle.isVisible() || await legacy.isVisible()).toBe(true);
  if (await ready()) return;
  if (await toggle.isVisible()) await toggle.click();
  else await legacy.click();
  await expect.poll(ready).toBe(true);
}

export async function taskPropertyRow(page: Page, label: string) {
  const row = page.locator('[data-property-row]:not([inert] *):not([aria-hidden="true"] *)')
    .filter({ has: page.locator(`[data-property-label=${JSON.stringify(label)}]`) }).filter({ visible: true });
  const tab = page.getByRole("tab", { name: "Properties", exact: true }).filter({ visible: true });
  await openTaskSidePanel(page, async () => await row.isVisible() || await tab.isVisible());
  if (!await row.isVisible() && await tab.isVisible()) await tab.click();
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport();
  return row;
}
