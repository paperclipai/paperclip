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
  const account = connections.find((entry: { ownership: string; isDefault: boolean }) => entry.ownership === "personal" && entry.isDefault);
  expect(account, "The isolated drive should include an imported personal account").toBeTruthy();
  await page.goto(`/${prefix}/apps/${account.id}/permissions`);
  await expect(page.getByRole("heading", { name: account.name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Default for / })).toBeVisible();
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

test("personal provider defaults move the crown only after saving and survive refresh", async ({ page, request }, testInfo) => {
  const list = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
  const own = list.connections.filter((account: { provider: string; ownership: string; ownerUserId: string; canSetDefault: boolean; status: string }) =>
    account.provider === "openai" && account.ownership === "personal" && account.ownerUserId === list.currentUserId && account.canSetDefault && account.status === "connected");
  const previous = own.find((account: { isDefault: boolean }) => account.isDefault);
  const target = own.find((account: { isDefault: boolean }) => !account.isDefault);
  expect(previous, "Seed a selected personal OpenAI account").toBeTruthy();
  expect(target, "Seed a second personal OpenAI account").toBeTruthy();
  const others = list.connections.filter((account: { provider: string; isDefault: boolean }) => account.provider !== "openai" && account.isDefault).map((account: { grantId: string }) => account.grantId).sort();
  await page.goto(`/${prefix}/apps?source=installed`);
  const announcement = page.getByRole("button", { name: "Dismiss announcement" });
  if (await announcement.isVisible()) await announcement.click();
  const provider = page.locator('[data-app-slug="openai"]');
  const expand = async () => {
    const trigger = provider.getByRole("button", { name: /^\d+ connections$/ });
    if (await trigger.getAttribute("data-state") === "closed") await trigger.click();
  };
  await expect(provider).toBeVisible();
  await expand();
  const crown = provider.getByRole("button", { name: "Your default for OpenAI" });
  await expect(crown.locator("..")).toContainText(previous.name);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route(`**/api/companies/${companyId}/ai-connections/default`, async route => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ grantId: target.grantId });
    await held;
    await route.continue();
  });
  const manage = provider.getByRole("button", { name: `Manage ${target.name} connection` });
  await manage.click();
  await page.screenshot({ path: testInfo.outputPath("default-menu.png") });
  await page.getByRole("menuitem", { name: "Set as default for OpenAI", exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(crown.locator("..")).toContainText(previous.name);
  await manage.click();
  await expect(page.getByRole("menuitem", { name: "Set as default for OpenAI", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  release();
  await expect(crown.locator("..")).toContainText(target.name);
  await expect(manage).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("default-saved.png"), fullPage: true });
  await page.unroute(`**/api/companies/${companyId}/ai-connections/default`);
  const saved = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
  expect(saved.connections.filter((account: { provider: string; isDefault: boolean }) => account.provider === "openai" && account.isDefault).map((account: { grantId: string }) => account.grantId)).toEqual([target.grantId]);
  expect(saved.connections.filter((account: { provider: string; isDefault: boolean }) => account.provider !== "openai" && account.isDefault).map((account: { grantId: string }) => account.grantId).sort()).toEqual(others);
  await page.reload();
  await expand();
  await expect(crown.locator("..")).toContainText(target.name);
  await crown.scrollIntoViewIfNeeded();
  await crown.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("tooltip")).toHaveText("Your default for OpenAI");

  // One failed preference write retains the saved crown; retry sends the same
  // explicit target through the real endpoint without starting provider login.
  await page.route(`**/api/companies/${companyId}/ai-connections/default`, async route => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Disposable QA save failure" }) });
  }, { times: 1 });
  await provider.getByRole("button", { name: `Manage ${previous.name} connection` }).click();
  await page.getByRole("menuitem", { name: "Set as default for OpenAI", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t change your OpenAI default" })).toBeVisible();
  await expect(crown.locator("..")).toContainText(target.name);
  await page.getByRole("alert").filter({ hasText: "Couldn’t change your OpenAI default" }).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(crown.locator("..")).toContainText(previous.name);
  const shared = saved.connections.find((account: { provider: string; ownership: string }) => account.provider === "openai" && account.ownership === "shared");
  if (shared) {
    await provider.getByRole("button", { name: `Manage ${shared.name} connection` }).click();
    await expect(page.getByRole("menuitem", { name: /default for OpenAI/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
});

test("personal provider defaults expose crown meaning on touch in both themes at 390px", async ({ browser, request }, testInfo) => {
  const list = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
  const selected = list.connections.find((account: { provider: string; isDefault: boolean }) => account.provider === "openai" && account.isDefault);
  expect(selected).toBeTruthy();
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${testInfo.project.use.baseURL}/${prefix}/apps?source=installed`);
    const announcement = page.getByRole("button", { name: "Dismiss announcement" });
    if (await announcement.isVisible()) await announcement.click();
    const provider = page.locator('[data-app-slug="openai"]');
    await provider.getByRole("button", { name: /^\d+ connections$/ }).tap();
    const crown = provider.getByRole("button", { name: "Your default for OpenAI" });
    await crown.scrollIntoViewIfNeeded();
    await crown.tap();
    await expect(page.getByRole("tooltip")).toHaveText("Your default for OpenAI");
    await page.keyboard.press("Escape");
    await provider.getByRole("button", { name: `Manage ${selected.name} connection` }).tap();
    await expect(page.getByRole("menuitem", { name: "Default for OpenAI", exact: true })).toHaveAttribute("aria-disabled", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`default-mobile-${colorScheme}.png`) });
    await context.close();
  }
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
  test(`Connections reuses the local browser sign-in step for ${label} (simulated auth)`, async ({ page }, testInfo) => {
    // UI contract only: real subscription qualification is provider-connections.
    const base = `/api/companies/${companyId}/ai-connections/local`;
    const sessionId = "22222222-2222-4222-8222-222222222222";
    await page.route(`**${base}/attempts`, route => route.fulfill({ json: { sessionId, expiresAt: new Date(Date.now() + 300000).toISOString() } }));
    await page.route(`**${base}/check`, route => route.fulfill({ json: { status: "sign_in_required", authorizationUrl: "https://provider.example/authorize", ...(provider === "openai" ? { code: "ABCD-EFGH" } : {}) } }));
    await page.route(`**${base}/attempts/${sessionId}`, route => route.fulfill({ json: { ok: true } }));
    await page.goto(`/${prefix}/apps/connect?source=${provider}&method=ai-subscription`);
    await expect(page.getByRole("radiogroup", { name: "Connect your model provider" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect for tool access instead" })).toHaveCount(0);
    await page.getByRole("radio", { name: new RegExp(label) }).click();
    await expect(page.getByRole("link", { name: `Sign in to ${label}`, exact: true })).toHaveAttribute("href", "https://provider.example/authorize");
    await expect(page.getByText(/CODEX_HOME=|claude auth login|existing terminal login/)).toHaveCount(0);
    if (provider === "anthropic") await expect(page.getByRole("button", { name: "Submit code", exact: true })).toBeDisabled();
    else await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
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
