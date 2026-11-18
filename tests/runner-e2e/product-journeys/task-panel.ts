import { expect, type Locator, type Page } from "@playwright/test";

export function visiblePropertyRow(page: Page, label: string): Locator {
  return page.locator('[data-property-row]:not([inert] *):not([aria-hidden="true"] *)')
    .filter({ has: page.locator(`[data-property-label="${label}"]`) }).filter({ visible: true });
}

export async function openTaskPanelTab(page: Page, tabName: "Properties" | "Artifacts", ready: Locator): Promise<void> {
  const name = new RegExp(`^${tabName}`);
  const tab = page.getByRole("tab", { name }).filter({ visible: true }).first();
  const option = page.getByRole("option", { name }).filter({ visible: true }).first();
  const newTab = page.getByRole("button", { name: "Open a new tab", exact: true }).filter({ visible: true }).first();
  const opener = page.getByRole("button", { name: /^(Show properties|Properties)$/ }).filter({ visible: true }).first();
  const toggle = page.getByRole("button", { name: "Toggle side panel", exact: true, pressed: false }).filter({ visible: true }).first();
  const anyVisible = async (...locators: Locator[]) => {
    for (const locator of locators) if (await locator.isVisible()) return true;
    return false;
  };
  for (let step = 0; step < 4; step++) {
    await expect.poll(() => anyVisible(ready, tab, option, newTab, toggle, opener)).toBe(true);
    if (await ready.isVisible()) return;
    if (await option.isVisible()) { await option.click(); await expect(ready).toBeVisible(); }
    else if (await tab.isVisible()) { await tab.click(); await expect(ready).toBeVisible(); }
    else if (await newTab.isVisible()) { await newTab.click(); await expect(option).toBeVisible(); }
    else {
      if (await toggle.isVisible()) await toggle.click();
      else await opener.click();
      await expect.poll(() => anyVisible(ready, tab, option, newTab)).toBe(true);
    }
  }
  await expect(ready).toBeVisible();
}

export async function showPropertyRow(page: Page, label: string): Promise<Locator> {
  const row = visiblePropertyRow(page, label);
  await openTaskPanelTab(page, "Properties", row);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport();
  return row;
}
