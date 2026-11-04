import { expect, type Page } from "@playwright/test";

export async function downloadTaskTextArtifact(page: Page, attachmentId: string, name: string) {
  const contentPath = `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
  const chip = page.getByTestId("task-chat-bubble-attachments").locator(`a[href*="${contentPath}"]`).last();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAttribute("aria-label", `Open ${name}`);
  await chip.click();
  const control = page.getByRole("link", { name: `Download ${name}`, exact: true });
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute("href", `${contentPath}?download=1`);
  const [download] = await Promise.all([page.waitForEvent("download"), control.click()]);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Delivered text artifact did not download through its visible control");
  return downloadPath;
}
