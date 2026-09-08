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

    // `--data-dir` starts a new server, not a new browser profile. Keep a
    // resumable draft here so this ordinary browser condition is covered when
    // the company-list invalidation runs after the create request.
    await page.addInitScript(() => {
      localStorage.setItem("paperclip-onboarding-state", JSON.stringify({
        step: 1,
        companyName: "",
        createdCompanyId: null,
      }));
    });
    let delayCompanyListRefetch = false;
    await page.route("**/api/companies", async (route) => {
      if (delayCompanyListRefetch && route.request().method() === "GET") {
        // Keep the invalidation observable: a background fetch must not reset
        // the in-progress wizard.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await route.continue();
    });

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
    delayCompanyListRefetch = true;
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

  test("connect step starts the sign-in when the source is chosen, rather than hiring, when the signal reports no credential", async ({
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

    // The sign-in Connect now starts. Stubbed so the card is deterministic:
    // the session start answers, and the guarded prompt read hands back an
    // authorization URL for the card's link row.
    await page.route("**/setup-token-login-sessions", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "e2e-setup-token-session",
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      }),
    );
    await page.route("**/setup-token-login-sessions/*/prompt", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authorizationUrl: "https://claude.ai/oauth/authorize?code=true&client=e2e",
          transportAdvisory: null,
        }),
      }),
    );
    await page.route("**/setup-token-login-sessions/e2e-setup-token-session", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "e2e-setup-token-session",
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
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

    // Step 4 (Connect a model). By role rather than by label, because which
    // adapters the row offers depends on the registry this environment reports.
    const source = page.getByRole("radio").first();
    await source.waitFor({ timeout: 30_000 });

    // Nothing before the row is answered: the card is the answer to the tile,
    // and the button has nothing to do until there is a source to do it with.
    const cardInstruction = page.getByText("then come back and enter authorization code");
    await expect(cardInstruction).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();

    // Answering the row is what starts the sign-in — this is the ordering the
    // step exists to enforce, since a hire here would file an agent with no
    // credential to run on. It is also the whole of the interaction: there is
    // no second press between choosing a source and being signed in.
    await source.click();

    await expect(cardInstruction).toBeVisible({ timeout: 30_000 });
    // One destination, two ways to it: the card's own link for anyone
    // finishing in another browser, and the step's button for the flow.
    const cardLink = page.getByRole("link", { name: /^Sign in to / });
    await expect(cardLink).toBeVisible({ timeout: 15_000 });
    await expect(cardLink).toHaveAttribute("href", /claude\.ai\/oauth\/authorize/);
    await expect(
      page.getByRole("button", { name: /^Sign in to / }),
    ).toBeEnabled({ timeout: 15_000 });
    // No "Use saved login" here: the hire step applies a stored login itself.
    await expect(page.getByRole("button", { name: "Use saved login" })).toHaveCount(0);
    expect(hireCalled).toBe(false);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });
  test("a reload during a login resumes the same session", async ({ page }) => {
    // The last piece of the resume feature: a customer who reloads the page
    // mid-login must see the same login still running, not the tile row
    // again and not a second session started behind their back.
    //
    // A bare `/onboarding` reload is not the right way to exercise this: that
    // route always forces its own fixed entry step (see
    // `resolveRouteOnboardingOptions` — a bare `/onboarding` hit is a request
    // to start a new company, by design, and always wins over a saved draft's
    // step). A returning visit to an existing company's own onboarding path
    // (`/{prefix}/onboarding`) is the real "reopen onboarding" entry point, so
    // this test reloads through that path instead, landing on the agent step
    // with the draft's agent name already restored, then advances once to the
    // connect step — where the resumed login must already be running.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    const FAKE_SANDBOX_ENVIRONMENT_ID = "e2e-fake-sandbox-environment-reload";
    const FAKE_SANDBOX_PROVIDER = "e2e-fake-provider-reload";

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

    await page.route("**/adapters/*/auth-signal*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "absent" }),
      }),
    );

    const SESSION_ID = "e2e-reload-setup-token-session";
    const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize?code=true&client=e2e-reload";
    let startCalls = 0;
    // Flips once the login actually starts, so the owner-scoped resume read
    // below answers "no active session" until then — matching the real
    // route, and keeping the pre-Connect part of this test the same as the
    // ordinary sign-in test above.
    let sessionStarted = false;
    await page.route("**/setup-token-login-sessions", (route) => {
      if (route.request().method() === "POST") {
        startCalls += 1;
        sessionStarted = true;
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      });
    });
    await page.route(`**/setup-token-login-sessions/${SESSION_ID}/prompt`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authorizationUrl: AUTHORIZATION_URL,
          transportAdvisory: null,
        }),
      }),
    );
    await page.route(`**/setup-token-login-sessions/${SESSION_ID}`, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      });
    });
    // The owner-scoped resume read. Both the wizard's own step-restore effect
    // and the panel's own resume-on-mount read use this, with no session id
    // in the URL — the caller rediscovers its own session.
    await page.route("**/setup-token-login-sessions/active", (route) => {
      if (!sessionStarted) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Setup-token login session not found." }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          panelMode: "submitted_browser_code",
          prompt: { authorizationUrl: AUTHORIZATION_URL, transportAdvisory: null },
        }),
      });
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
    await page.getByPlaceholder("e.g. Northwind Labs").fill(`${COMPANY_NAME}-reload`);
    await page.getByRole("button", { name: /^Continue/ }).click();

    await page.waitForSelector("#onboarding-agent-name", { timeout: 30_000 });
    await page.locator("#onboarding-agent-name").fill("Ada");
    await page.getByRole("button", { name: "Next" }).click();

    const source = page.getByRole("radio").first();
    await source.waitFor({ timeout: 30_000 });

    // Answering the row is what starts the sign-in now — there is no separate
    // Connect press between choosing a source and being signed in.
    await source.click();

    const cardInstruction = page.getByText("then come back and enter authorization code");
    const authorizationLink = page.getByRole("link", { name: /^Sign in to / });

    await expect(cardInstruction).toBeVisible({ timeout: 30_000 });
    await expect(authorizationLink).toBeVisible({ timeout: 15_000 });
    await expect(authorizationLink).toHaveAttribute("href", /claude\.ai\/oauth\/authorize/);
    expect(startCalls).toBe(1);

    const companiesRes = await page.request.get("/api/companies");
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === `${COMPANY_NAME}-reload`,
    );
    expect(company, "the created company should exist").toBeTruthy();

    // Reload through the company's own onboarding path — the real "reopen
    // onboarding" entry point for a company that already exists.
    await page.goto(`/${company.issuePrefix}/onboarding`);

    // This entry point always re-enters on the agent step, with the agent
    // name restored from the draft. One more press reaches the connect step.
    await page.waitForSelector("#onboarding-agent-name", { timeout: 30_000 });
    await expect(page.locator("#onboarding-agent-name")).toHaveValue("Ada");
    await page.getByRole("button", { name: "Next" }).click();

    // The resumed login shows with no new source pick and no fresh sign-in
    // press: the panel and the step both discover it from the caller's active
    // session.
    await expect(cardInstruction).toBeVisible({ timeout: 15_000 });
    await expect(authorizationLink).toBeVisible({ timeout: 15_000 });
    expect(startCalls, "the reload must resume the session, not start a new one").toBe(1);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });

  test("connect step blocks the hire when the environment probe fails and no sign-in is needed", async ({
    page,
  }) => {
    // The other half of what the test above used to cover. The two claims are
    // different situations now: there, an absent credential makes Connect start
    // a sign-in; here there is no sandbox to sign in against — this throwaway
    // instance only auto-creates the local environment, and nothing below adds
    // one — so Connect goes straight to the probe, and the probe is the gate.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

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
    await page.getByPlaceholder("e.g. Northwind Labs").fill(`${COMPANY_NAME}-probe-gate`);
    await page.getByRole("button", { name: /^Continue/ }).click();

    await page.waitForSelector("#onboarding-agent-name", { timeout: 30_000 });
    await page.locator("#onboarding-agent-name").fill("Ada");
    await page.getByRole("button", { name: "Next" }).click();

    const source = page.getByRole("radio").first();
    await source.waitFor({ timeout: 30_000 });
    await source.click();

    const connect = page.getByRole("button", { name: "Connect", exact: true });
    await expect(connect).toBeEnabled({ timeout: 30_000 });
    await connect.click();

    // The failed probe blocks the hire and shows its own checks.
    await expect(page.getByText("The claude CLI was not found on this host.")).toBeVisible({
      timeout: 15_000,
    });
    expect(hireCalled).toBe(false);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });
});
