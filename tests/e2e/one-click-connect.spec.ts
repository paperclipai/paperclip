import { expect, test } from "@playwright/test";

test("a one-click connector starts sign-in from its card, skipping the confirmation screen", async ({ page, request }) => {
  const res = await request.post("/api/companies", { data: { name: `one-click connect ${Date.now()}` } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  const prefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
  try {
    await page.goto(`/${prefix}/apps`);
    await page.getByRole("searchbox", { name: "Search plugins" }).fill("Notion");
    const popupOpened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect Notion", exact: true }).click();
    const popup = await popupOpened;

    // The flow takes over the window the card opened and starts on its own,
    // so the "Continue to Notion" confirmation never shows.
    await expect(page).toHaveURL(new RegExp(`/${prefix}/apps/connect\\?source=notion`), { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /Preparing secure sign-in|Opening Notion|Notion couldn’t connect/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Continue to Notion" })).toHaveCount(0);
    await popup.close().catch(() => undefined);

    // Without a window from a click, a reload falls back to the confirmation screen.
    await page.reload();
    await expect(page.getByRole("button", { name: "Continue to Notion" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await request.delete(`/api/companies/${company.id}`).catch(() => undefined);
  }
});
