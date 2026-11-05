import type { Page } from "@playwright/test";
export function personalSecretEntryDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /^Set your value/ }) });
}
