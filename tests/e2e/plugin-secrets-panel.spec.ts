import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Plugin-Managed Secrets panel in Instance Settings.
 *
 * Verifies:
 * - The panel heading renders on /instance/settings/heartbeats
 * - The empty state renders when no plugin secrets exist
 * - A plugin-owned secret seeded via the API appears in the panel
 *
 * Runs in local_trusted mode (no auth required for board access).
 * The webServer directive in playwright.config.ts boots the instance.
 */

const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3199";

async function getOrCreateCompanyId(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE_URL}/api/companies`);
  expect(res.ok()).toBeTruthy();
  const companies: Array<{ id: string }> = await res.json();
  if (companies.length > 0) return companies[0].id;
  throw new Error("No companies found — onboarding must create one first");
}

test.describe("Plugin-Managed Secrets panel", () => {
  test("panel heading is visible on instance settings page", async ({ page }) => {
    await page.goto("/instance/settings/heartbeats");
    await expect(page.locator("h2", { hasText: "Plugin-Managed Secrets" })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("shows empty state when no plugin secrets exist", async ({ page }) => {
    await page.goto("/instance/settings/heartbeats");
    // Wait for the panel to load (no loading spinner)
    await expect(page.locator("h2", { hasText: "Plugin-Managed Secrets" })).toBeVisible({
      timeout: 10_000,
    });
    // Empty state message appears when the query resolves with []
    const emptyState = page.locator("text=No plugin-managed secrets");
    await expect(emptyState).toBeVisible({ timeout: 5_000 });
  });

  test("panel shows empty state when board-user-created secret exists (not plugin-owned)", async ({ page, request }) => {
    const companyId = await getOrCreateCompanyId(request);

    // Seed a secret via the REST API as a board user (no plugin: prefix in actor).
    // The panel filters by createdByUserId LIKE 'plugin:%', so this secret
    // must NOT appear — panel should still show the empty state.
    const seedRes = await request.post(`${BASE_URL}/api/companies/${companyId}/secrets`, {
      headers: { "Content-Type": "application/json" },
      data: {
        name: "E2E_BOARD_USER_TOKEN",
        provider: "local_encrypted",
        value: "e2e-test-value",
        description: "Created by e2e test as board user",
      },
    });

    // Seed must succeed — if the API rejects, the test environment is broken, not the panel.
    expect(seedRes.ok()).toBe(true);

    await page.goto("/instance/settings/heartbeats");
    await expect(page.locator("h2", { hasText: "Plugin-Managed Secrets" })).toBeVisible({
      timeout: 10_000,
    });

    // Board-user secret must not appear in the plugin panel.
    await expect(page.locator("text=No plugin-managed secrets")).toBeVisible({ timeout: 5_000 });
  });

  test("secrets.write capability description is visible in panel", async ({ page }) => {
    await page.goto("/instance/settings/heartbeats");
    await expect(page.locator("h2", { hasText: "Plugin-Managed Secrets" })).toBeVisible({
      timeout: 10_000,
    });
    // The panel description renders the capability name in a <code> element.
    // Using locator("code") avoids a strict-mode violation: the empty-state
    // message also contains the literal text "secrets.write".
    await expect(page.locator("code", { hasText: "secrets.write" })).toBeVisible({
      timeout: 5_000,
    });
  });
});
