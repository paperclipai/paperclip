import { test, expect } from "@playwright/test";

// Opt in against an isolated test drive; never seed or modify a production account.
const companyId = process.env.AI_CONNECTIONS_TEST_COMPANY_ID;
test.skip(!companyId, "Provide the isolated test-drive company ID");
let prefix: string;

test.beforeAll(async ({ request }) => {
  const response = await request.get(`/api/companies/${companyId}`);
  expect(response.ok()).toBe(true);
  prefix = (await response.json()).issuePrefix;
});

test("existing Connections lists AI providers and keeps account management compact", async ({ page, request }, testInfo) => {
  await page.goto(`/${prefix}/apps`);
  for (const provider of ["Anthropic", "OpenAI", "OpenRouter", "Grok"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^(Add account|Connect) ${provider}$`) })).toBeVisible();
  }
  const { connections } = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
  const account = connections.find((entry: { ownership: string }) => entry.ownership === "personal");
  expect(account, "The isolated drive should include an imported personal account").toBeTruthy();
  await page.goto(`/${prefix}/apps/${account.id}/permissions`);
  await expect(page.getByRole("heading", { name: account.name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Personal default", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to Connectors", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Which humans can use this credential?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Which agents can use this connection?" })).toBeVisible();
  await expect(page.getByText("Authorized use for other users’ tasks", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Authorize an agent" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("account-details.png"), fullPage: true });
  await page.getByRole("button", { name: "Reconnect", exact: true }).last().click();
  await expect(page.getByText("Step 1 of 1", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Connection name")).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Which humans can use this credential?" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
});

test("rejected API credentials do not create a connection, and cancellation returns to Connections", async ({ page, request }, testInfo) => {
  const before = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
  await page.goto(`/${prefix}/apps/connect?source=openrouter&method=ai-api_key`);
  await page.getByRole("button", { name: /^(Save and continue|Continue)$/ }).click();
  await page.getByLabel("Connection name").fill("Rejected browser test account");
  await page.getByRole("textbox", { name: "API key", exact: true }).fill("invalid-ai-connection-browser-test");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/rejected|Could not verify|could not verify/);
  await expect(page.getByRole("textbox", { name: "API key", exact: true })).toHaveValue("");
  const after = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
  expect(after.connections.map((entry: { id: string }) => entry.id).sort()).toEqual(before.connections.map((entry: { id: string }) => entry.id).sort());
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await expect(page).toHaveURL(new RegExp(`/${prefix}/apps$`));
});

test("legacy adoption and inline account cancellation preserve the agent configuration", async ({ page, request }, testInfo) => {
  const agents = await (await request.get(`/api/companies/${companyId}/agents`)).json();
  const agent = agents.find((entry: { adapterType: string; runtimeConfig: { aiConnection?: unknown } }) => ["claude_local", "codex_local", "grok_local"].includes(entry.adapterType) && !entry.runtimeConfig.aiConnection);
  expect(agent, "The drive should include a legacy agent for adoption review").toBeTruthy();
  await page.goto(`/${prefix}/agents/${agent.urlKey ?? agent.id}/runtime`);
  await page.getByRole("button", { name: "Choose a managed connection", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI connection", exact: true })).toBeVisible();
  await expect(page.getByText("Your personal accounts", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect another account", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect another account", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("agent-ai-connection.png"), fullPage: true });
  await page.getByRole("button", { name: /Responsible user’s connection/ }).click();
  await expect(page.getByRole("dialog")).toContainText(`Adopt Connections for ${agent.name}`);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  const after = await (await request.get(`/api/agents/${agent.id}`)).json();
  expect(after.adapterType).toBe(agent.adapterType);
  expect(after.adapterConfig).toEqual(agent.adapterConfig);
  expect(after.runtimeConfig).toEqual(agent.runtimeConfig);
});


test("connection setup waits for provider details before enabling Continue", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/companies/${companyId}/tools/gallery`, async route => {
    await held;
    await route.continue();
  });
  await page.goto(`/${prefix}/apps/connect?source=openrouter&method=ai-api_key`);
  const next = page.getByRole("button", { name: /^(Save and continue|Continue)$/ });
  await expect(next).toBeDisabled();
  release();
  await next.click();
  await expect(page.getByLabel("Connection name")).toBeVisible();
  await expect(page).toHaveURL(/stage=setup/);
});

test("new OpenRouter agents use the visible binding and provider model catalog", async ({ page }) => {
  let tested: { aiConnection?: unknown; adapterConfig?: { model?: string } } | undefined;
  await page.route(`**/api/companies/${companyId}/adapters/opencode_local/models*`, async route => {
    expect(new URL(route.request().url()).searchParams.get("provider")).toBe("openrouter");
    await route.fulfill({ json: [{ id: "openrouter/anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" }] });
  });
  await page.route(`**/api/companies/${companyId}/adapters/opencode_local/test-environment`, async route => {
    tested = route.request().postDataJSON();
    await route.fulfill({ json: { status: "pass", checks: [], testedAt: new Date().toISOString() } });
  });
  await page.goto(`/${prefix}/agents/new?name=OpenRouter+binding+regression&adapterType=opencode_local`);
  await expect(page.getByText("Existing authentication — not managed by Connections", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Responsible user’s connection/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Select model (required)", exact: true }).click();
  await page.getByRole("button", { name: "anthropic/claude-sonnet-4.5", exact: true }).click();
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await expect.poll(() => tested).toBeTruthy();
  expect(tested?.aiConnection).toEqual({ provider: "openrouter", method: "api_key", mode: "responsible_user" });
  expect(tested?.adapterConfig?.model).toBe("openrouter/anthropic/claude-sonnet-4.5");
});

test("ordinary Anthropic setup keeps the existing tool method available", async ({ page }) => {
  await page.goto(`/${prefix}/apps/connect?source=anthropic`);
  await page.getByRole("button", { name: /^(Save and continue|Continue)$/ }).click();
  await expect(page.getByText("How do you want to connect?", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Use an API key", exact: true }).click();
  await expect(page.getByLabel("Your Anthropic key", { exact: true })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Connect your model provider" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${prefix}/apps$`));
});

test("explicit OpenAI API method survives continuing and reloading", async ({ page }) => {
  await page.goto(`/${prefix}/apps/connect?source=openai&method=ai-api_key`);
  await page.getByRole("button", { name: /^(Save and continue|Continue)$/ }).click();
  await expect(page).toHaveURL(/method=ai-api_key/);
  await page.reload();
  await page.getByRole("radio", { name: /OpenAI/ }).click();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByText(/CODEX_HOME=/)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
});

for (const [provider, label] of [["anthropic", "Claude"], ["openai", "OpenAI"]]) {
  test(`Connections reuses the agent provider step for ${label}`, async ({ page }, testInfo) => {
    await page.goto(`/${prefix}/apps/connect?source=${provider}&method=ai-subscription`);
    await page.getByRole("button", { name: /^(Save and continue|Continue)$/ }).click();
    await expect(page.getByRole("radiogroup", { name: "Connect your model provider" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect for tool access instead" })).toHaveCount(0);
    await page.getByRole("radio", { name: new RegExp(label) }).click();
    if (provider === "anthropic") {
      await expect(page.getByText(/Connect uses your local/)).toBeVisible();
      await expect(page.getByText("claude auth login", { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText(/Your existing terminal login stays separate/)).toBeVisible();
      const command = page.getByText(/^CODEX_HOME=.* codex login$/);
      await expect(command).toBeVisible();
      const preparedCommand = await command.textContent();
      await page.reload();
      await page.getByRole("radio", { name: new RegExp(label) }).click();
      await expect(command).toHaveText(preparedCommand!);
    }
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    // Let the shared tile-collapse and card-enter animations settle for visual review.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: testInfo.outputPath(`${provider}-shared-provider-step.png`), fullPage: true });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Use API key instead", exact: true }).click();
    await page.getByRole("radio", { name: new RegExp(label) }).click();
    await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
    await expect(page.getByText(/Provide your .* API key to connect/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/${prefix}/apps$`));
  });
}

// Exercise the real onboarding login controllers; only provider/server replies
// are simulated. No credentials, sandbox leases or accounts are created here.
for (const [provider, label, adapter] of [["anthropic", "Claude", "claude_local"], ["openai", "OpenAI", "codex_local"]]) {
  test(`Connections uses onboarding browser sign-in for ${label}`, async ({ page }, testInfo) => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const base = `/api/companies/${companyId}`;
    const sessions = provider === "anthropic" ? `${base}/setup-token-login-sessions` : `${base}/adapters/${adapter}/login-sessions`;
    let starts = 0;
    let cancels = 0;
    let intent: Record<string, unknown> | undefined;
    const session = () => ({ sessionId, environmentId, adapterType: adapter, status: provider === "anthropic" ? "awaiting_code" : "awaiting_user", expiresAt: new Date(Date.now() + 300000).toISOString(), aiConnection: intent, prompt: provider === "anthropic" ? { authorizationUrl: "https://provider.example/authorize" } : { url: "https://provider.example/authorize", code: "ABCD-EFGH" } });
    await page.route(`**${base}/environments`, route => route.fulfill({ json: [{ id: environmentId, name: "Browser sign-in test sandbox", driver: "sandbox", status: "active", config: { provider: "browser-test" } }] }));
    await page.route(`**${base}/environments/capabilities`, route => route.fulfill({ json: { sandboxProviders: { "browser-test": { supportsLoginPty: true } } } }));
    await page.route(`**${sessions}**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/active")) return route.fulfill(starts ? { json: session() } : { status: 404, json: { error: "Not found" } });
      if (path.endsWith("/cancel")) { cancels++; return route.fulfill({ json: {} }); }
      if (path.endsWith("/prompt")) return route.fulfill({ json: { authorizationUrl: "https://provider.example/authorize" } });
      if (path === sessions && route.request().method() === "POST") {
        starts++;
        const payload = route.request().postDataJSON();
        expect(payload.environmentId).toBe(environmentId);
        expect(payload.aiConnection.provider).toBe(provider);
        intent = payload.aiConnection;
      }
      return route.fulfill({ json: session() });
    });
    await page.addInitScript(() => { window.open = (url) => { (window as unknown as { loginDestination: string }).loginDestination = String(url); return null; }; });
    await page.goto(`/${prefix}/apps/connect?source=${provider}&method=ai-subscription`);
    await page.getByRole("button", { name: /^(Save and continue|Continue)$/ }).click();
    await page.getByRole("radio", { name: new RegExp(label) }).click();
    const signIn = page.getByRole("button", { name: `Sign in to ${label}`, exact: true });
    await expect(signIn).toBeEnabled();
    await expect(page.getByText(/login on this machine/)).toHaveCount(0);
    if (provider === "anthropic") await expect(page.locator('input[type="password"]')).toBeVisible();
    else await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
    await signIn.click();
    expect(await page.evaluate(() => (window as unknown as { loginDestination: string }).loginDestination)).toBe("https://provider.example/authorize");
    await expect(page.getByRole("button", { name: "Waiting for code", exact: true })).toBeDisabled();
    // The shared footer label animates; capture after it has settled.
    await page.waitForTimeout(600);
    await page.screenshot({ path: testInfo.outputPath(`${provider}-onboarding-browser-login.png`), fullPage: true });
    if (provider === "anthropic") {
      const submitted = page.waitForRequest(request => request.url().endsWith(`${sessionId}/code`) && request.method() === "POST");
      await page.locator('input[type="password"]').fill("storybook-fixture-code");
      await page.locator('input[type="password"]').press("Enter");
      await submitted;
      await expect(page.getByRole("button", { name: "Connecting", exact: true })).toBeDisabled();
    }
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("radio", { name: new RegExp(label) }).click();
    await expect(page.getByRole("button", { name: `Sign in to ${label}`, exact: true })).toBeEnabled();
    expect(starts).toBe(1);
    expect(cancels).toBe(0);
  });
}
