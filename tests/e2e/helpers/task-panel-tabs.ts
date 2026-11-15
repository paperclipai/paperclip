import { expect, type Locator, type Page } from "@playwright/test";

export async function expectTaskPanelTab(panel: Locator, mobile: boolean, name: string) {
  if (mobile) {
    await expect(panel.getByRole("tabpanel")).toHaveAccessibleName(name);
    await expect(panel.getByRole("button", { name: /^Switch tabs, \d+ open$/ })).toContainText(name);
  } else {
    await expect(panel.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  }
}

export async function selectTaskPanelTab(page: Page, panel: Locator, mobile: boolean, name: string) {
  if (mobile) {
    await panel.getByRole("button", { name: /^Switch tabs, \d+ open$/ }).click();
    await page.getByRole("dialog", { name: "Open tabs", exact: true }).getByRole("button", { name, exact: true }).click();
  } else {
    await panel.getByRole("tab", { name, exact: true }).click();
  }
  await expectTaskPanelTab(panel, mobile, name);
}
