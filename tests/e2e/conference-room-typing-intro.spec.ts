import { test, expect, type Page } from "@playwright/test";
import { mockOnboardingLocalAiConnection } from "./helpers/onboarding-ai-connection";
import {
  expectLandsOnChatWithoutDashboardBounce,
  instrumentNavLog,
} from "./helpers/onboarding-landing";

/** Post-wizard onboarding opens the standing chat without execution work.
 * PAP-404: company page memory must not bounce the new chat to the dashboard. */

/**
 * Intercept authentication, environment checks, and hiring so no real CLI check
 * runs and no real agent process spawns (the hire still happens server-side
 * with an inert http adapter).
 */
async function installLaunchIntercepts(page: Page, baseURL?: string) {
  await mockOnboardingLocalAiConnection(page);
  // Keep the inert provider from starting; verify the welcome is requested only
  // after navigation and the conversation composer are visible.
  await page.route("**/onboarding/greeting", async route => {
    await expect(page).toHaveURL(/\/chats\/[^/]+$/);
    await expect(page.getByTestId("task-chat-composer-add")).toBeVisible();
    await route.fulfill({ json: { started: false } });
  });
  await page.route("**/test-environment", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: "pass", checks: [] }),
    }),
  );

  await page.route("**/agent-hires", async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() || "{}");
    const auth = req.headers().authorization;
    const real = await fetch(new URL(req.url(), baseURL).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify({
        name: body.name,
        role: body.role,
        adapterType: "http",
        adapterConfig: { url: "http://127.0.0.1:1/dead" },
        runtimeConfig: { heartbeat: { enabled: false } },
      }),
    });
    await route.fulfill({
      status: real.status,
      contentType: "application/json",
      body: await real.text(),
    });
  });
}

/** Drive the wizard from the /onboarding route through to "Get started". */
async function runOnboardingWizard(page: Page, companyName: string, signIn?: { source: RegExp; complete: () => Promise<void> }) {
  await page.goto("/onboarding");

  // Launcher card path (existing companies) — enter the wizard if the
  // route shows a launcher instead of opening the wizard directly.
  const startBtn = page.getByRole("button", { name: /Start Onboarding/i });
  if (await startBtn.count()) await startBtn.first().click();

  // Step 0: front door (skipped when the wizard opens on the create path).
  const frontDoor = page.getByText("Build a new organization");
  if (await frontDoor.count()) await frontDoor.first().click();

  // Step 1: company name.
  await page.getByPlaceholder("e.g. Northwind Labs").fill(companyName);
  await page.getByRole("button", { name: /^Continue/ }).click();

  // Step 1's "Next" creates the company; the mission step no longer runs.

  // Step 3: name the agent. The role picker is gone — the arc asks for a
  // name and hires under the neutral `general` role.
  await page.waitForSelector("#onboarding-agent-name", { timeout: 30_000 });
  await page.locator("#onboarding-agent-name").fill("Ada");
  await page.getByRole("button", { name: /^Next$/ }).click();

  // Step 4: pick a model source, then advance. Nothing is selected on arrival
  // — the row is a question, not a confirmation — so the CTA is disabled until
  // a tile is pressed. By role rather than by label: which adapters the tiles
  // offer depends on the registry this environment reports.
  const source = signIn ? page.getByRole("radio", { name: signIn.source }) : page.getByRole("radio").first();
  await source.waitFor({ timeout: 30_000 });
  await source.click();

  // A verified account, or pasting its authorization code, continues
  // automatically through the environment check and hire.
  if (signIn) await signIn.complete();

  // Step 5: review → Get started opens the standing chat.
  const getStarted = page.getByRole("button", { name: /Get started/ });
  await getStarted.waitFor({ timeout: 20_000 });
  await getStarted.click();
}

async function assertOnlyChatExists(page: Page, companyName: string) {
  const companiesRes = await page.request.get("/api/companies");
  expect(companiesRes.ok()).toBe(true);
  const companies = await companiesRes.json();
  const company = companies.find(
    (candidate: { name: string }) => candidate.name === companyName,
  );
  expect(company).toBeTruthy();

  const issuesRes = await page.request.get(`/api/companies/${company.id}/issues`);
  expect(issuesRes.ok()).toBe(true);
  const issues = await issuesRes.json();
  expect(issues).toEqual([]);
  const projectsRes = await page.request.get(`/api/companies/${company.id}/projects`);
  expect(projectsRes.ok()).toBe(true);
  expect(await projectsRes.json()).toEqual([]);
  const chatsRes = await page.request.get(`/api/companies/${company.id}/chats`);
  expect(chatsRes.ok()).toBe(true);
  const chats = await chatsRes.json();
  expect(chats).toHaveLength(1);
  expect(chats[0]).toMatchObject({ originKind: "onboarding_chat", projectId: null });
  await expect(page.getByTestId("task-chat-composer-add")).toBeVisible();
}

test.describe("Chat launch after onboarding wizard", () => {
  test("pasting a Claude code connects automatically and continues onboarding", async ({ page, baseURL }) => {
    await installLaunchIntercepts(page, baseURL);
    let verified = false;
    let submissions = 0;
    await page.route("**/ai-connections/local/attempts", route => route.fulfill({ status: 201, json: {
      sessionId: "00000000-0000-4000-8000-000000000001", expiresAt: "2099-01-01T00:00:00Z",
    } }));
    await page.route("**/ai-connections/local/check", route => route.fulfill({ json: verified
      ? { status: "ready" }
      : { status: "sign_in_required", authorizationUrl: "https://claude.ai/oauth/authorize?fixture=auto-paste" },
    }));
    await page.route("**/ai-connections/local/attempts/*/code", async route => {
      expect(route.request().postDataJSON()).toEqual({ browserCode: "fixture-authorization-code" });
      submissions++;
      verified = true;
      await route.fulfill({ json: { ok: true } });
    });
    const companyName = `E2E-ClaudePaste-${Date.now()}`;
    await runOnboardingWizard(page, companyName, { source: /Claude/, complete: async () => {
      const code = page.getByRole("textbox", { name: "Authorization code", exact: true });
      await expect(code).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("button", { name: "Sign in to Claude", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
      await code.evaluate(input => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "fixture-authorization-code");
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
      });
      await expect(page.getByRole("status").filter({ hasText: "Finishing sign-in" })).toBeVisible();
    } });
    expect(submissions).toBe(1);
    await assertOnlyChatExists(page, companyName);
  });

  test("opens chat without creating a task or project", async ({ page, baseURL }) => {
    await instrumentNavLog(page);
    await installLaunchIntercepts(page, baseURL);

    const companyName = `E2E-TypingIntro-${Date.now()}`;
    await runOnboardingWizard(page, companyName);

    await expectLandsOnChatWithoutDashboardBounce(page);
    await assertOnlyChatExists(page, companyName);
    await page.screenshot({ path: test.info().outputPath("onboarding-chat.png"), fullPage: true });
  });

  // PAP-404 regression: the dashboard bounce only fires when the instance
  // already has a company for the route-sync effect to reset selection to.
  // Seed one first, then onboard a brand-new company and assert we still land
  // in chat without a dashboard bounce.
  test("lands on chat even when a company already exists", async ({
    page,
    baseURL,
  }) => {
    await instrumentNavLog(page);
    await installLaunchIntercepts(page, baseURL);

    // Seed a pre-existing company so the companies list is non-empty when the
    // wizard launches — the exact condition that reproduced the bounce.
    const seedRes = await page.request.post("/api/companies", {
      data: { name: `E2E-Seed-${Date.now()}` },
    });
    expect(seedRes.ok()).toBe(true);

    const companyName = `E2E-TypingIntro-Existing-${Date.now()}`;
    await runOnboardingWizard(page, companyName);

    await expectLandsOnChatWithoutDashboardBounce(page);
    await assertOnlyChatExists(page, companyName);
  });
});
