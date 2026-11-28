import { test, expect } from "@playwright/test";
import { mockOnboardingLocalAiConnection } from "./helpers/onboarding-ai-connection";

/**
 * E2E: Onboarding wizard reload resume, probe-failure gating, and duplicate
 * draft handling split out of onboarding.spec.ts so serial E2E shards stay
 * under 75s.
 */

const COMPANY_NAME = `E2E-Test-${Date.now()}`;

test.describe("Onboarding wizard", () => {
  test("a reload during a login resumes the same session", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const loginSessionReads: string[] = [];
    page.on("request", (request) => {
      const match = new URL(request.url()).pathname.match(/\/setup-token-login-sessions\/([^/]+)(?:\/prompt)?$/);
      if (match && match[1] !== "active") loginSessionReads.push(match[1]);
    });
    let hireCalls = 0;
    await page.route("**/agent-hires", (route) => {
      hireCalls += 1;
      return route.fulfill({ status: 400, json: { error: "Unexpected hire while login is pending." } });
    });

    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    const FAKE_SANDBOX_ENVIRONMENT_ID = "a6d2e530-1e8b-4f0b-9c94-42f1d23e8750";
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

    await page.route("**/api/adapters?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("environmentId") !== FAKE_SANDBOX_ENVIRONMENT_ID) return route.continue();
      url.searchParams.delete("environmentId");
      const response = await route.fetch({ url: url.toString() });
      expect(response.ok()).toBe(true);
      await route.fulfill({ response });
    });

    await page.route("**/api/agents/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON();
      if (body.defaultEnvironmentId !== FAKE_SANDBOX_ENVIRONMENT_ID) return route.continue();
      const response = await route.fetch({ postData: JSON.stringify({ ...body, defaultEnvironmentId: null }) });
      await route.fulfill({ response });
    });

    const SESSION_ID = "e2e-reload-setup-token-session";
    const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize?code=true&client=e2e-reload";
    let startCalls = 0;
    let sessionStarted = false;
    const resumedCompanyIds: string[] = [];
    let aiConnection: Record<string, unknown> | undefined;
    await page.route("**/setup-token-login-sessions", (route) => {
      if (route.request().method() === "POST") {
        startCalls += 1;
        sessionStarted = true;
        aiConnection = route.request().postDataJSON().aiConnection;
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          environmentId: FAKE_SANDBOX_ENVIRONMENT_ID,
          aiConnection,
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
          environmentId: FAKE_SANDBOX_ENVIRONMENT_ID,
          aiConnection,
          status: "pending",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      });
    });
    await page.route("**/setup-token-login-sessions/active", (route) => {
      if (!sessionStarted) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Setup-token login session not found." }),
        });
      }
      resumedCompanyIds.push(new URL(route.request().url()).pathname.split("/")[3]);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          environmentId: FAKE_SANDBOX_ENVIRONMENT_ID,
          aiConnection,
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
    await source.click();

    const cardInstruction = page.getByText("then come back and enter authorization code");
    const authorizationLink = page.getByRole("link", { name: /^Sign in to / });

    await expect(cardInstruction).toBeVisible({ timeout: 30_000 });
    await expect(authorizationLink).toBeVisible({ timeout: 15_000 });
    await expect(authorizationLink).toHaveAttribute("href", AUTHORIZATION_URL);
    expect(startCalls).toBe(1);

    const companiesRes = await page.request.get("/api/companies");
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === `${COMPANY_NAME}-reload`,
    );
    expect(company, "the created company should exist").toBeTruthy();

    const savedSelection = {
      step: 4,
      companyName: `${COMPANY_NAME}-reload`,
      agentName: "Ada",
      adapterType: "claude_local",
      runner: "auto",
      credentialMode: "subscription",
      credentialModeChoice: null,
      createdCompanyId: company.id,
      createdCompanyPrefix: company.issuePrefix,
      createdAgentId: null,
    };
    const readDraft = () => page.evaluate(() => JSON.parse(localStorage.getItem("paperclip-onboarding-state") ?? "null"));
    await expect.poll(readDraft).toMatchObject(savedSelection);
    const { setupAgentId } = await readDraft();
    await expect.poll(async () => (await (await page.request.get(`/api/agents/${setupAgentId}?companyId=${company.id}`)).json()).metadata?.setupAdapterPending).toBe(false);
    const setupResponse = await page.request.get(`/api/agents/${setupAgentId}?companyId=${company.id}`);
    expect(setupResponse.ok()).toBe(true);
    const setup = await setupResponse.json();
    expect(setup).toMatchObject({ id: setupAgentId, name: "Ada", pauseReason: "setup" });
    const resumedSelection = { ...savedSelection, setupAgentId,
      runner: setup.adapterType === "paperclip_runner" ? "paperclip" : "legacy" };
    const assertResumedLogin = async () => {
      await expect(page.getByRole("heading", { name: "Connect a model", exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("onboarding-wizard").getByText("Ada", { exact: true })).toBeVisible();
      await expect(page.getByRole("radio", { name: "Claude Subscription", exact: true })).toBeChecked();
      await expect(cardInstruction).toBeVisible({ timeout: 15_000 });
      await expect(authorizationLink).toBeVisible({ timeout: 15_000 });
      await expect(authorizationLink).toHaveAttribute("href", AUTHORIZATION_URL);
      await expect.poll(readDraft).toMatchObject(resumedSelection);
      expect(startCalls, "reopening must resume the session without a second source choice").toBe(1);
      expect(hireCalls, "a pending login must not hire an agent").toBe(0);
      expect(loginSessionReads.length).toBeGreaterThan(0);
      expect(new Set(loginSessionReads)).toEqual(new Set([SESSION_ID]));
      expect(new Set(resumedCompanyIds)).toEqual(new Set([company.id]));
    };

    const beforeReopenReads = resumedCompanyIds.length;
    await page.goto(`/${company.issuePrefix}/onboarding`);
    await expect.poll(() => resumedCompanyIds.length, { timeout: 15_000 }).toBeGreaterThan(beforeReopenReads);
    await assertResumedLogin();

    const beforeReloadReads = resumedCompanyIds.length;
    await page.reload();
    await expect.poll(() => resumedCompanyIds.length, { timeout: 15_000 }).toBeGreaterThan(beforeReloadReads);
    await assertResumedLogin();

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });

  test("connect step blocks the hire when the environment probe fails after account connection", async ({
    page,
  }) => {
    await mockOnboardingLocalAiConnection(page);
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

    await expect(page.getByText("The claude CLI was not found on this host.")).toBeVisible({
      timeout: 15_000,
    });
    expect(hireCalled).toBe(false);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });

  test("duplicate name drafts can select Copilot before connecting a GitHub account", async ({ page }) => {
    const response = await page.request.post("/api/companies", { data: { name: `${COMPANY_NAME}-duplicate-copilot` } });
    expect(response.ok()).toBe(true);
    const company = await response.json();
    await page.goto(`/${company.issuePrefix}/agents/all`);
    let duplicate: { id: string; name: string };
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("toolbar", { name: "Agents controls" }).getByRole("button", { name: "New Agent", exact: true }).click();
      await page.getByLabel("Agent name", { exact: true }).fill("Echo");
      const setupResponse = page.waitForResponse(result => result.request().method() === "POST" && result.url().endsWith(`/api/companies/${company.id}/agents`));
      await page.getByRole("button", { name: "Choose adapter", exact: true }).click();
      duplicate = await (await setupResponse).json();
      await expect(page.getByRole("heading", { name: "Choose an adapter", exact: true })).toBeVisible();
      if (attempt === 0) await page.keyboard.press("Escape");
    }
    expect(duplicate!.name).toBe("Echo 2");
    await expect(page.getByText("How should Echo 2 work?", { exact: true })).toBeVisible();
    await page.locator("label").filter({ has: page.locator('input[name="new-agent-adapter"][value="copilot_runtime"]') }).click();
    await page.getByRole("button", { name: "Configure agent", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Configure your agent", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("setupAgentId")).toBe(duplicate!.id);
    const saved = await (await page.request.get(`/api/agents/${duplicate!.id}?companyId=${company.id}`)).json();
    expect(saved).toMatchObject({ id: duplicate!.id, name: "Echo 2", pauseReason: "setup", adapterConfig: { provider: "acpx", acpxAgent: "copilot" } });
    expect(saved.runtimeConfig.aiConnection).toBeUndefined();
  });
});
