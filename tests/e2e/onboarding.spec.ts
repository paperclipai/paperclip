import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding wizard flow (NUX Phase 2 expanded wizard).
 *
 * The wizard now opens on a front door (path picker) and the "Create a new
 * company" path runs:
 *   Step 0  — Front door (Create a new company / Level up existing)
 *   Step 1a — Name your organization (creates the company)
 *   Step 2  — Hire your team lead (adapter picker)
 *   Step 3+ — Launch celebration → CEO chat → hiring plan → orientation
 *
 * This test covers the deterministic, LLM-free core: it drives the front door
 * through company naming (which creates the company) and verifies the wizard
 * advances to the team-lead step without asking for a mission.
 *
 * The tail (CEO chat at step 4, hiring-plan generation at step 5, final
 * landing) depends on a live LLM and is verified separately during manual /
 * LLM-backed QA — see PAP-50. Surface-level rendering of every step is
 * snapshotted by nux-phase4-screenshots.spec.ts.
 */

const COMPANY_NAME = `E2E-Test-${Date.now()}`;

test.describe("Onboarding wizard", () => {
  test("create-company path: naming creates the company, and no goal is invented", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // New-NUX surfaces are flag-gated default-OFF (PAP-136/137/138): turn the
    // experimental flag on for this throwaway instance before driving them.
    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    await page.goto("/onboarding");

    // The wizard may open on a launcher card or directly on the capsule
    // wizard; the front door (step 0) requires a click into the create path.
    const startBtn = page.getByRole("button", {
      name: /Start Onboarding|New Organization|Add Agent/,
    });
    if (await startBtn.count()) {
      await startBtn.first().click();
    }
    const createCard = page.getByRole("button", { name: /Build a new organization/ });
    if (await createCard.count()) {
      await createCard.first().click();
    }

    // Step 1 — Name your organization.
    await expect(
      page.getByRole("heading", { name: "What is the name of your organization?" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("e.g. Northwind Labs").fill(COMPANY_NAME);
    await page.getByRole("button", { name: /^Continue/ }).click();

    // Step 1's "Next" now creates the company and goes straight to the agent.
    // The mission step used to sit between them and do the creating; onboarding
    // no longer asks for the mission, which is collected later in the app.
    await page.waitForSelector("#onboarding-agent-name", {
      timeout: 30_000,
    });

    // Verify the company + company-level goal were persisted.
    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === COMPANY_NAME,
    );
    expect(company, `company ${COMPANY_NAME} should exist`).toBeTruthy();

    // And no company-level goal, which is the point rather than an omission.
    // Onboarding no longer asks for a mission, so writing one here would mean
    // inventing a goal the customer never chose. The mission is collected later
    // in the app, and the absence is what leaves room for it.
    const goalsRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/goals`,
    );
    expect(goalsRes.ok()).toBe(true);
    const goals = await goalsRes.json();
    const companyGoal = (Array.isArray(goals) ? goals : []).find(
      (g: { level?: string }) => g.level === "company",
    );
    expect(
      companyGoal,
      "onboarding must not invent a mission the customer never gave",
    ).toBeFalsy();

    // The expanded wizard must not crash the app (Rules-of-Hooks regression).
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });

  test("adapter step shows the login panel from the cheap auth signal, and blocks the hire on a failed test", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    // The login panel's capability gate requires a sandbox environment with a
    // login-capable provider, and this throwaway instance has neither: it
    // only auto-creates the local environment. Add one fake sandbox
    // environment to the real list, make it the instance default, and declare
    // its provider's login pseudo-terminal capability — this reproduces the
    // gate a real sandbox-backed instance would already pass, without
    // changing any other field the rest of the page depends on.
    const FAKE_SANDBOX_ENVIRONMENT_ID = "e2e-fake-sandbox-environment";
    const FAKE_SANDBOX_PROVIDER = "e2e-fake-provider";

    await page.route("**/environments", async (route) => {
      const response = await route.fetch();
      const environments = await response.json();
      environments.push({
        id: FAKE_SANDBOX_ENVIRONMENT_ID,
        name: "E2E fake sandbox",
        description: null,
        driver: "sandbox",
        status: "active",
        config: { provider: FAKE_SANDBOX_PROVIDER },
        envVars: {},
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await route.fulfill({ response, json: environments });
    });

    await page.route("**/environments/capabilities", async (route) => {
      const response = await route.fetch();
      const capabilities = await response.json();
      capabilities.sandboxProviders[FAKE_SANDBOX_PROVIDER] = {
        status: "supported",
        supportsSavedProbe: true,
        supportsUnsavedProbe: true,
        supportsRunExecution: true,
        supportsReusableLeases: false,
        supportsInteractiveSetup: false,
        interactiveSetupConnectionTypes: [],
        supportsTemplateCapture: false,
        supportsTemplateDelete: false,
        supportsLoginPty: true,
        source: "plugin",
      };
      await route.fulfill({ response, json: capabilities });
    });

    await page.route("**/instance/settings", async (route) => {
      const response = await route.fetch();
      const settings = await response.json();
      settings.defaultEnvironmentId = FAKE_SANDBOX_ENVIRONMENT_ID;
      await route.fulfill({ response, json: settings });
    });

    // Report no ready credential, so the wizard shows the login panel right
    // after the adapter is picked, before it ever runs an adapter test.
    await page.route("**/adapters/*/auth-signal*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "absent" }),
      }),
    );

    // Fail the adapter test the "Connect" button runs, so the hire gate
    // blocks the create and this test can prove no agent is hired.
    await page.route("**/test-environment", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          adapterType: "claude_local",
          status: "fail",
          checks: [
            {
              code: "claude_cli_not_found",
              level: "fail",
              message: "The claude CLI was not found on this host.",
            },
          ],
          testedAt: new Date().toISOString(),
        }),
      }),
    );

    let hireCalled = false;
    await page.route("**/agent-hires", (route) => {
      hireCalled = true;
      return route.continue();
    });

    await page.goto("/onboarding");

    const startBtn = page.getByRole("button", {
      name: /Start Onboarding|New Organization|Add Agent/,
    });
    if (await startBtn.count()) {
      await startBtn.first().click();
    }
    const createCard = page.getByRole("button", { name: /Build a new organization/ });
    if (await createCard.count()) {
      await createCard.first().click();
    }

    await expect(
      page.getByRole("heading", { name: "What is the name of your organization?" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("e.g. Northwind Labs").fill(`${COMPANY_NAME}-auth-signal`);
    await page.getByRole("button", { name: /^Continue/ }).click();

    await page.waitForSelector("#onboarding-agent-name", { timeout: 30_000 });
    await page.locator("#onboarding-agent-name").fill("Ada");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 4 (Connect a model): the default adapter is claude_local, and the
    // signal above reports no ready credential, so the login panel must show
    // with no button to reuse a saved login.
    //
    // The panel names the provider rather than the plumbing it runs on, so this
    // title is per-adapter. "Sign in to the environment" is now only the fallback
    // for an adapter with no known provider name, which claude_local is not.
    await expect(page.getByText("Sign in to Anthropic")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Use saved login" })).toHaveCount(0);

    // Exact, because the progress strip's segments are buttons too and one of
    // them is labelled "Connect a model" for assistive tech. An unanchored
    // /^Connect/ matches both it and this CTA, which is a strict-mode violation
    // rather than a wrong click — Playwright refuses instead of guessing.
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    // The failed test blocks the hire and shows its own checks.
    await expect(page.getByText("The claude CLI was not found on this host.")).toBeVisible({
      timeout: 15_000,
    });
    expect(hireCalled).toBe(false);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });
});
