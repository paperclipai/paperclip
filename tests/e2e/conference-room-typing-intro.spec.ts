import { test, expect, type Page } from "@playwright/test";
import {
  expectLandsOnFirstTaskWithoutDashboardBounce,
  instrumentNavLog,
} from "./helpers/onboarding-landing";

/**
 * E2E: post-wizard onboarding launch.
 *
 * Completing the onboarding wizard now creates the first assigned task and
 * drops the user straight onto that task's detail page (not the dashboard),
 * so they land in the conversation the agent will start in. The chat intro
 * still has unit coverage in BoardChat tests.
 *
 * PAP-404: onboarding used to intermittently bounce to the company dashboard.
 * The bounce only reproduces when the instance already has ≥1 company (the
 * board's test ports), so the second test seeds a company first to exercise
 * exactly that failing condition.
 */

const MISSION = "Verify the first-task launch survives the wizard handoff.";
const FIRST_TASK_TITLE = "Paperclip onboarding";

/**
 * Intercept the two side-effecting calls the wizard makes so no real CLI check
 * runs and no real agent process spawns (the hire still happens server-side
 * with an inert http adapter).
 */
async function installLaunchIntercepts(page: Page, baseURL?: string) {
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
async function runOnboardingWizard(page: Page, companyName: string) {
  await page.goto("/onboarding");

  // Launcher card path (existing companies) — enter the wizard if the
  // route shows a launcher instead of opening the wizard directly.
  const startBtn = page.getByRole("button", { name: /Start Onboarding/i });
  if (await startBtn.count()) await startBtn.first().click();

  // Step 0: front door (skipped when the wizard opens on the create path).
  const frontDoor = page.getByText("Build a new company");
  if (await frontDoor.count()) await frontDoor.first().click();

  // Step 1: company name.
  await page.getByPlaceholder("Acme Corp").fill(companyName);
  await page.getByRole("button", { name: /^Next/ }).click();

  // Step 2: mission (direct path default).
  await page.getByPlaceholder("What is your team trying to achieve?").fill(MISSION);
  await page.getByRole("button", { name: /Confirm mission/ }).click();

  // Step 3: lead name (prefilled) → Next.
  await page.waitForSelector('input[placeholder="Chief of staff"]', {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /^Next/ }).click();

  // Step 4: adapter (claude_local default); heartbeat is intercepted.
  await page.getByRole("button", { name: /^Connect$/ }).click();

  // Step 5: review → Get started creates the first task and opens its
  // detail page.
  const getStarted = page.getByRole("button", { name: /Get started/ });
  await getStarted.waitFor({ timeout: 20_000 });
  await getStarted.click();
}

async function assertFirstTaskExists(page: Page, companyName: string) {
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
  const firstTask = issues.find(
    (candidate: { title: string }) => candidate.title === FIRST_TASK_TITLE,
  );
  expect(firstTask).toBeTruthy();
  await expect(page.getByText(FIRST_TASK_TITLE).first()).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("First-task launch after onboarding wizard", () => {
  test("creates the first task and opens its detail page", async ({ page, baseURL }) => {
    await instrumentNavLog(page);
    await installLaunchIntercepts(page, baseURL);

    const companyName = `E2E-TypingIntro-${Date.now()}`;
    await runOnboardingWizard(page, companyName);

    await expectLandsOnFirstTaskWithoutDashboardBounce(page);
    await assertFirstTaskExists(page, companyName);
  });

  // PAP-404 regression: the dashboard bounce only fires when the instance
  // already has a company for the route-sync effect to reset selection to.
  // Seed one first, then onboard a brand-new company and assert we still land
  // on the first task without a dashboard bounce.
  test("lands on the first task even when a company already exists", async ({
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

    await expectLandsOnFirstTaskWithoutDashboardBounce(page);
    await assertFirstTaskExists(page, companyName);
  });
});
