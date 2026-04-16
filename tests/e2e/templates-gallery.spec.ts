import { test, expect } from "@playwright/test";

/**
 * E2E: Template Gallery install flow (smoke test).
 *
 * Navigates to /templates, clicks the first "Install" button, and waits for
 * the UI to redirect to the installed company's dashboard. The install path
 * performs a real GitHub fetch + bundle import via the portability service,
 * which is why the redirect wait allows up to 120s.
 *
 * Auth: the e2e webServer runs in local_trusted deployment mode (see
 * playwright.config.ts), so board-level routes like /templates require no
 * explicit login — same convention as tests/e2e/onboarding.spec.ts.
 */

test.describe("Template Gallery", () => {
  test("lists templates and installs one", async ({ page }) => {
    await page.goto("/templates");

    await expect(
      page.getByRole("heading", { name: /template gallery/i }),
    ).toBeVisible({ timeout: 10_000 });

    const firstInstall = page.getByRole("button", { name: /install/i }).first();
    await expect(firstInstall).toBeVisible();

    await firstInstall.click();

    // Install kicks off a real GitHub fetch + bundle import; allow up to 120s
    // for the redirect to /<companyId>/dashboard. The companyId segment is a
    // DB-generated id (not an uppercase issuePrefix), so match any non-empty
    // path segment before /dashboard.
    await page.waitForURL(/\/[^/]+\/dashboard(\/|$|\?)/, { timeout: 120_000 });
  });
});
