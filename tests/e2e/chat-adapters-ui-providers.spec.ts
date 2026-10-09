import { oauthCallbackInterstitialHtml } from "../../server/src/lib/oauth-browser-return";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  expectMinimumProviderSetup,
  expectProviderTryInstructions,
  expectSetupRail,
  fillProviderSetup,
  installChatControlPlaneMock,
  seedCompanyAndAgent,
  selectMaya,
  PROVIDER_LIFECYCLE_COPY,
  PROVIDERS,
  expectedCredentialKeys,
  type ProviderCase,
  type Seed,
  type ChatMock,
  GITHUB_PRIVATE_KEY_PASTE_FIXTURE,
} from "./chat-adapters-ui.shared";

async function findConnectorBySearch(page: Page, query: string, slug: string) {
  const search = page.getByRole("searchbox", { name: "Search connectors" });
  await expect(search).toBeVisible();
  await search.fill(query);
  const connector = page.locator(`[role="listitem"][data-app-slug="${slug}"]`);
  await expect(connector).toBeVisible({ timeout: 30_000 });
  return connector;
}

async function exerciseGitHubReviewSetup(page: Page, mock: ChatMock, seed: Seed, provider: ProviderCase, testInfo: TestInfo) {
  await expect(page.getByRole("heading", { name: "Choose agent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select agent…", exact: true }).click();
  await page.getByRole("button", { name: "Select Maya", exact: true }).click();
  await expect(page.getByText("Maya is not configured for low-trust review")).toBeVisible();
  await expect(page.getByRole("link", { name: "Learn about low-trust agents" })).toHaveAttribute("href", /trust-and-low-trust-review/);
  await testInfo.attach("Choose agent — inline low-trust warning", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Change Maya to a low trust agent" }).click();
  await expect(page.getByText("Maya is not configured for low-trust review")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => mock.createdWithAgentId).toBe(seed.agentId);
  await expect(page.getByRole("heading", { name: "Connect GitHub", exact: true })).toBeVisible();
  await expect(page.getByLabel("GitHub account")).toHaveValue("personal");
  await expect(page.getByLabel("App name", { exact: true })).toHaveValue("Maya");
  await page.getByLabel("GitHub account").selectOption("organization");
  await page.getByLabel("Organization", { exact: true }).fill("paperclip-ai");
  await testInfo.attach("Connect GitHub — organization", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Save & exit", exact: true }).click();
  await page.goto(`/${seed.prefix}/apps/chat/connect?provider=github&purpose=chat&resume=endpoint-github`);
  await expect(page.getByLabel("GitHub account")).toHaveValue("organization");
  await expect(page.getByLabel("Organization", { exact: true })).toHaveValue("paperclip-ai");
  await expect(page.getByRole("button", { name: "Select agent…", exact: true })).toHaveCount(0);
  // Existing-App recovery stays available and preserves entered credentials after failure.
  await page.getByRole("button", { name: "I already have an App" }).click();
  await page.getByLabel("App ID", { exact: true }).fill("123456");
  await page.getByLabel("Private key", { exact: true }).fill(GITHUB_PRIVATE_KEY_PASTE_FIXTURE);
  await page.getByLabel("Webhook secret", { exact: true }).fill("github-webhook-secret");
  await page.getByRole("button", { name: "Connect existing App", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("GitHub rejected the supplied App credentials.");
  await expect(page.getByLabel("Private key", { exact: true })).toHaveValue(GITHUB_PRIVATE_KEY_PASTE_FIXTURE);
  await page.getByRole("button", { name: "Connect existing App", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect your account", exact: true })).toBeVisible();
  await page.getByLabel("Existing GitHub connection").selectOption("personal-github");
  await expect(page.getByRole("button", { name: "Check my account" })).toBeVisible();
  await page.getByRole("button", { name: "Check my account" }).click();
  expect(mock.githubIdentityConfirmed).toBe(false);
  await page.getByRole("button", { name: "Confirm my account" }).click();
  await expect.poll(() => mock.githubIdentityConfirmed).toBe(true);
  await expect(page.getByRole("heading", { name: "GitHub connected", exact: true })).toBeVisible();
  await expect(page.getByText("1 repository enabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Finish|Verify connection|Refresh access|Save repositories/ })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL(/\/apps\/chat\/endpoint-github\/settings$/);
  const nav = page.getByRole("navigation", { name: "Chat connection" });
  for (const tab of ["Settings", "Access", "Reviews", "Conversations", "Activity"]) {
    await expect(nav.getByRole("link", { name: tab, exact: true })).toBeVisible();
  }
  await nav.getByRole("link", { name: "Access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page.getByText("No reviews yet", { exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(page.getByRole("list", { name: "Conversations", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connection activity", exact: true })).toBeVisible();
  await page.getByText("Connection health and controls", { exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => mock.lifecycleActions).toEqual(["pause", "resume"]);
  await page.getByRole("button", { name: "Replay failed delivery", exact: true }).click();
  await expect.poll(() => mock.replayedDelivery).toBe(true);
  mock.setStatus("attention");
  await page.reload();
  await page.getByText("Connection health and controls", { exact: true }).click();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect GitHub", exact: true })).toBeVisible();
  await expect(page.getByText(/Leave these blank to reuse/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose an agent", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Private key", { exact: true })).toHaveValue("");
  const reconnectResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat-endpoints/endpoint-github/setup") &&
    response.request().method() === "POST" &&
    response.request().postDataJSON().action === "reconnect",
  );
  await page.getByRole("button", { name: "Reconnect App", exact: true }).click();
  const reconnected = await reconnectResponse;
  expect(reconnected.request().postDataJSON()).toEqual({ action: "reconnect" });
  expect(await reconnected.json()).toMatchObject({ assignedAgentId: seed.agentId, assignedAgentName: "Maya" });
  await expect(page.getByRole("heading", { name: "GitHub connected", exact: true })).toBeVisible();
  mock.setStatus("active");
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Maya", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Activity", exact: true }).click();
  await page.getByText("Connection health and controls", { exact: true }).click();
  await page.getByRole("button", { name: "Remove connection", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove connection", exact: true }).click();
  await expect.poll(() => mock.removed).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`));
}

/**
 * Native chat-connector provider setup coverage: adapter install/lifecycle
 * flows and the iMessage Photon variant. Shared fixtures and the
 * chat-control-plane mock live in ./chat-adapters-ui.shared.ts; the
 * messaging-flow describes run in chat-adapters-ui-messaging.spec.ts.
 */
test("Slack OAuth continuation reloads once from the callback origin without echoing the code", async ({ page }) => {
  const sites: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    sites.push(req.headers["sec-fetch-site"] as string | undefined);
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Cache-Control", "no-store");
    if (sites.length === 1) res.end(oauthCallbackInterstitialHtml());
    else res.end("<h1>Callback completed</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing callback fixture listener");
    const callback = `http://127.0.0.1:${address.port}/callback?code=fixture-code`;
    await page.route("https://slack.test/consent", route => route.fulfill({ contentType: "text/html", body: `<a href="${callback}">Approve installation</a>` }));
    await page.goto("https://slack.test/consent");
    await page.getByRole("link", { name: "Approve installation" }).click();
    await expect(page.getByRole("heading", { name: "Callback completed" })).toBeVisible();
    expect(sites.slice(0, 2)).toEqual(["cross-site", "same-origin"]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test.describe.serial("native chat adapter UI", () => {
  test.setTimeout(180_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });

  test("Slack: automatic creation survives refresh, consent, and connection evidence without copying durable secrets", async ({ page }) => {
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    const mock = await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, automaticSlack: true });
    async function holdSetupRequest(action: "registration" | "install") {
      let release!: () => void;
      let received!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const requested = new Promise<void>(resolve => { received = resolve; });
      await page.route(`**/api/chat-endpoints/endpoint-slack/slack/${action}`, async route => {
        received();
        await pending;
        await route.fallback();
      }, { times: 1 });
      return { release, requested };
    }
    async function expectNavigationLocked() {
      const steps = page.getByRole("navigation", { name: "Connection setup progress" }).getByRole("button");
      await expect(steps).toHaveCount(4);
      for (const step of await steps.all()) await expect(step).toBeDisabled();
      await expect(page.getByRole("button", { name: "Save & exit", exact: true })).toBeDisabled();
    }
    const rootUrl = new URL(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-slack`, test.info().project.use.baseURL).href;
    const callbackUrl = new URL("/api/chat-slack/oauth/callback?state=fixture-state&code=fixture-code", rootUrl).href;
    let callbackRequests = 0;
    await page.route("**/api/chat-slack/oauth/callback?**", async route => {
      callbackRequests += 1;
      if (callbackRequests === 1) {
        const body = oauthCallbackInterstitialHtml();
        expect(body).not.toContain("fixture-code");
        await route.fulfill({ contentType: "text/html", body });
      } else {
        mock.setSlackInstalled();
        await route.fulfill({ status: 303, headers: { location: rootUrl } });
      }
    });
    await page.context().route("https://slack.test/**", async route => {
      await route.fulfill({ contentType: "text/html", body: `<h1>Fixture Slack consent</h1><a href="${callbackUrl}">Approve installation</a>` });
    });
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat`);
    await expect(page.locator("summary:visible").filter({ hasText: "Advanced" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Set up with agent/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Choose an active agent" }).click();
    await page.getByRole("button", { name: "Select Maya", exact: true }).click();
    await page.locator("summary:visible").filter({ hasText: "Advanced" }).click();
    await expect(page.getByLabel("Slack app name", { exact: true })).toHaveValue("maya-paperclip");
    await expect(page.getByLabel("Bot display name", { exact: true })).toHaveValue("maya");
    await expect(page.getByLabel("Slash command", { exact: true })).toHaveValue("/maya");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "App configuration access token", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Get your App configuration access token" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use an existing app", exact: true })).toBeHidden();
    await page.getByLabel("App configuration access token", { exact: true }).fill("fixture-config-token");
    const creation = await holdSetupRequest("registration");
    const installationWindow = page.waitForEvent("popup");
    try {
      await page.getByRole("button", { name: "Create Slack app", exact: true }).click();
      await creation.requested;
      await expectNavigationLocked();
      await expect(page.getByLabel("App configuration access token", { exact: true })).toHaveValue("");
    } finally { creation.release(); }
    const consentWindow = await installationWindow;
    await expect(consentWindow.getByRole("heading", { name: "Fixture Slack consent" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Install Slack app", exact: true })).toBeVisible();
    await consentWindow.close();
    await expect(page.getByRole("navigation", { name: "Connection setup progress" }).getByRole("button", { name: /Choose agent/ })).toBeEnabled();
    expect(mock.slackCreations).toBe(1);
    await expect(page.getByLabel("Bot User OAuth Token", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Signing Secret", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Install Slack app", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save & exit", exact: true }).click();
    await page.goto(rootUrl);
    expect(mock.slackInstallations).toBe(1);
    const installation = await holdSetupRequest("install");
    try {
      await page.getByRole("button", { name: "Install in Slack", exact: true }).click();
      await installation.requested;
      await expectNavigationLocked();
    } finally { installation.release(); }
    await expect(page.getByRole("heading", { name: "Fixture Slack consent" })).toBeVisible();
    await page.getByRole("link", { name: "Approve installation" }).click();
    await expect(page.getByRole("heading", { name: "Send a message to your agent", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Slack app Settings" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Open Slack", exact: true })).toHaveAttribute("href", "https://app.slack.com/client/TE2E/DE2E");
    await page.getByText("Didn’t work?", { exact: true }).click();
    await expect(page.getByRole("link", { name: "Open Slack app Settings" })).toHaveAttribute("href", "https://api.slack.com/apps/AE2E/event-subscriptions");
    mock.setWebhookVerified();
    await expect(page.getByRole("heading", { name: "Success", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download avatar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Link .* to my Paperclip account/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open your Slack DM" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Success", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Connection setup progress" }).getByRole("button")).toHaveCount(4);
    expect(mock.slackCreations).toBe(1); expect(mock.slackInstallations).toBe(2);
    expect(callbackRequests).toBe(2);
    await page.screenshot({ path: test.info().outputPath("automatic-slack-success.png"), fullPage: true });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/chat\/endpoint-slack\/settings$/);
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(stored).not.toContain("fixture-config-token");
  });

  test("Slack: uncertain creation locks fields and offers manual recovery on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    const mock = await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, automaticSlack: true });
    mock.setSlackUncertain();
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-slack`);
    await expect(page.getByRole("alert")).toContainText("Slack may have created the app");
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await page.getByRole("navigation", { name: "Connection setup progress" }).getByRole("button", { name: /Choose agent/ }).click();
    await page.locator("summary:visible").filter({ hasText: "Advanced" }).click();
    await expect(page.getByLabel("Slack app name", { exact: true })).toHaveAttribute("readonly", "");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator("summary:visible").filter({ hasText: "Advanced" }).click();
    await expect(page.getByLabel("App configuration access token", { exact: true })).toHaveCount(0);
    const save = await page.getByRole("button", { name: "Save & exit", exact: true }).boundingBox();
    const create = await page.getByRole("button", { name: "Create Slack app", exact: true }).boundingBox();
    expect(Math.abs(save!.y - create!.y)).toBeLessThan(4);
    await page.getByRole("button", { name: "Use an existing app", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Add Slack credentials", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Add Slack credentials", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add Slack credentials", exact: true })).toBeVisible();
    expect(mock.slackCreations).toBe(0);
  });

  test("GitHub: the default-off gate keeps direct tool setup and fences chat routes", async ({
    page,
  }) => {
    const github = PROVIDERS.find(
      (provider) => provider.provider === "github",
    )!;
    const mock = await installChatControlPlaneMock(page, github, seed, {
      enableChatConnectors: true,
      enableGitHubReviewBots: false,
    });

    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible(
      { timeout: 30_000 },
    );
    const connector = await findConnectorBySearch(page, "GitHub", "github");
    // Without the cloud connector GitHub's default method is a token, so the
    // card's verb is "Add key" rather than "Connect".
    await connector.getByRole("button", { name: "Add key GitHub" }).click();

    await expect(page).toHaveURL(/\/apps\/connect\?/);
    expect(new URL(page.url()).searchParams.get("source")).toBe("github");
    // Identity is a stated default; its choices sit behind "Change".
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Connect GitHub as" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Choose how to connect" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Chat with an agent", { exact: true }),
    ).toHaveCount(0);

    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=github`);
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`));
    await expect(
      page.getByRole("heading", { name: "Connectors" }),
    ).toBeVisible();
    await page.goto(`/${seed.prefix}/apps/chat/endpoint-github/settings`);
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`));
    await expect.poll(() => mock.chatEndpointListReads).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Connect AgentMail", exact: true })).toBeVisible();
    expect(mock.createdWithAgentId).toBeNull();
  });

  for (const enabled of [false, true]) {
    test(`Agent Channels: default email surface and experimental providers (${enabled})`, async ({
      page,
    }) => {
      const github = PROVIDERS.find(
        (provider) => provider.provider === "github",
      )!;
      const mock = await installChatControlPlaneMock(page, github, seed, {
        enableChatConnectors: enabled,
      });

      await page.goto(`/${seed.prefix}/agents/${seed.agentId}/channels`);
      const channelsHeading = page.getByRole("heading", {
        name: "Channels",
        exact: true,
      });
      await expect(page).toHaveURL(/\/channels$/);
      await expect(channelsHeading).toHaveCount(1);
      await expect(channelsHeading).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Connect a channel" }),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Maya navigation" }).getByRole("link", { name: "Channels", exact: true }),
      ).toBeVisible();
      await expect.poll(() => mock.chatEndpointListReads).toBeGreaterThan(0);
      if (!enabled) {
        await expect(page.getByText("Connect AgentMail from Connectors.", { exact: true })).toBeVisible();
      }
    });
  }

  for (const provider of PROVIDERS) {
    test(`${provider.name}: catalog, setup, and connection management tabs`, async ({
      page,
    }, testInfo) => {
      const mock = await installChatControlPlaneMock(page, provider, seed, {
        enableChatConnectors: provider.provider !== "github",
        enableGitHubReviewBots: provider.provider === "github",
      });

      await page.goto(`/${seed.prefix}/apps`);
      await expect(
        page.getByRole("heading", { name: "Connectors" }),
      ).toBeVisible({ timeout: 30_000 });
      let connector = await findConnectorBySearch(page, provider.name, provider.slug);
      if (provider.provider === "github") {
        const tools = await findConnectorBySearch(page, "GitHub", "github");
        await tools.getByRole("button", { name: "Add key GitHub", exact: true }).click();
        await page.getByRole("button", { name: "Change", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Connect GitHub as" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Choose how to connect" })).toHaveCount(0);
        await page.goto(`/${seed.prefix}/apps`);
        connector = await findConnectorBySearch(page, provider.name, provider.slug);
      }
      await connector
        .getByRole("button", { name: `Connect ${provider.provider === "github" ? "GitHub Code Review Bot" : provider.name}` })
        .click();

      if (provider.chatAndTool) {
        await expect(
          page.getByRole("heading", { name: "Choose how to connect" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: /Chat with an agent/ }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: /Use this connection as an agent tool/,
          }),
        ).toBeVisible();
        const chatSetupUrl = page.url();
        const toolHref = new URL(chatSetupUrl).searchParams.get("toolHref");
        expect(toolHref).toBeTruthy();
        await page
          .getByRole("button", {
            name: /Use this connection as an agent tool/,
          })
          .click();
        await expect(page).toHaveURL(/\/apps\/connect\?/);
        expect(new URL(page.url()).searchParams.get("source")).toBe(
          provider.provider,
        );
        await page.goto(chatSetupUrl);
        await expect(
          page.getByRole("heading", { name: "Choose how to connect" }),
        ).toBeVisible();
        await page.getByRole("button", { name: /Chat with an agent/ }).click();
      } else {
        const chatOnlySetupUrl = new URL(page.url());
        expect(chatOnlySetupUrl.searchParams.get("purpose")).toBe("chat");
        expect(chatOnlySetupUrl.searchParams.get("toolHref")).toBeNull();
        await expect(
          page.getByRole("heading", { name: "Choose how to connect" }),
        ).toHaveCount(0);
      }

      if (provider.provider === "github") {
        await exerciseGitHubReviewSetup(page, mock, seed, provider, testInfo);
        return;
      }

      await expect(
        page.getByRole("heading", {
          name: "Which agent do you want to chat with?",
        }),
      ).toBeVisible();
      await expectSetupRail(page, true);
      await selectMaya(page);
      await expect.poll(() => mock.createdWithAgentId).toBe(seed.agentId);
      expect(mock.createdWithAgentId).not.toBe(seed.otherAgentId);
      await expect(
        page.getByRole("button", { name: "Choose an active agent" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: provider.setupHeading }),
      ).toBeVisible();
      await expect(
        page.getByText(PROVIDER_LIFECYCLE_COPY[provider.provider].reconnect, {
          exact: false,
        }),
      ).toHaveCount(0);
      await expectSetupRail(page);
      await expectMinimumProviderSetup(page, provider);
      await fillProviderSetup(page, provider);

      if (provider.provider === "github") {
        // A completed click does not mean the async configure request reached the mock.
        await expect.poll(() => mock.setupAttempts).toBe(2);
        expect(mock.githubPrivateKeyMatchedFile).toBe(true);
        expect(mock.githubPrivateKeyMatchedPaste).toBe(true);
      }

      if (provider.provider === "telegram") {
        const submittedToken = "123456:e2e-redacted";
        // The next step intentionally has its own identity-readiness alert.
        // Assert that this failed setup attempt clears, not that all alerts
        // disappear during the transition between two valid wizard states.
        const setupAlert = page.getByRole("alert").filter({
          has: page.getByText("Connection failed", { exact: true }),
        });
        await expect(setupAlert).toContainText("Connection failed");
        await expect(setupAlert).toContainText(
          "Telegram rejected bot token [redacted]. Confirm the token in BotFather and try again.",
        );
        await expect(page.locator("body")).not.toContainText(submittedToken);
        const tokenInput = page.getByLabel("Bot token");
        await expect(tokenInput).toHaveAttribute("type", "password");
        await expect(tokenInput).toHaveValue(submittedToken);
        await tokenInput.focus();
        await tokenInput.press("Tab");
        await expect(setupAlert).toBeVisible();

        await page.getByRole("button", { name: provider.setupButton }).click();
        await expect(
          page.getByRole("heading", { name: `Try Maya in ${provider.name}` }),
        ).toBeVisible();
        await expect(setupAlert).toHaveCount(0);
        expect(mock.setupAttempts).toBe(2);
      }

      if (provider.provider === "slack") {
        await expect(page.getByRole("heading", { name: "Verify Slack connection" })).toBeVisible();
        await expect(page.getByText("Slack needs to confirm that it can reach your Paperclip instance.")).toBeVisible();
        mock.setWebhookVerified();
        await expect(page.getByRole("heading", { name: "Connect your Slack account" })).toBeVisible();
        await expect(page.getByText("/maya connect", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Link Test operator to my Paperclip account" }).click();
        await page.getByRole("button", { name: "Continue to message test" }).click();
      }

      await expect(
        page.getByRole("heading", { name: `Try Maya in ${provider.name}` }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: provider.provider === "slack" ? "Done" : "I've sent the test message" }),
      ).toBeVisible();
      if (provider.provider !== "slack") {
        await expect(
          page.getByRole("heading", {
            name: "Link the account you’re testing",
          }),
        ).toBeVisible();
        await expect(
          page.getByText(
            /An observed external account is unlinked, and isolated guest work is off, so it cannot safely start Maya/,
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Review identity access" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Review identity access" })
          .click();
        await expect(page).toHaveURL(
          new RegExp(
            `/${seed.prefix}/apps/chat/endpoint-${provider.provider}/access$`,
          ),
        );
        await expect(
          page.getByRole("button", { name: "Continue setup" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Continue setup" }).click();
        expect(new URL(page.url()).searchParams.get("reconnect")).toBeNull();
        await expect(
          page.getByRole("heading", { name: `Try Maya in ${provider.name}` }),
        ).toBeVisible();
      }
      await expectSetupRail(page);
      await expectProviderTryInstructions(page, provider);
      expect(mock.configuredCredentialKeys).toEqual(
        expectedCredentialKeys(provider.provider),
      );
      await page
        .getByRole("button", { name: provider.provider === "slack" ? "Done" : "I've sent the test message" })
        .click();

      await expect(page).toHaveURL(
        new RegExp(
          `/${seed.prefix}/apps/chat/endpoint-${provider.provider}/settings$`,
        ),
      );
      await expect(
        page.getByRole("heading", { name: "Maya", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(provider.accountLabel, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue setup" }),
      ).toHaveCount(0);
      await expect(page.getByText("Change agent", { exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole("navigation", { name: "Chat connection" }).getByRole("link")).toHaveCount(4);
      for (const tab of ["Settings", "Access", "Conversations", "Activity"]) {
        await expect(page.getByRole("navigation", { name: "Chat connection" }).getByRole("link", { name: tab , exact: true })).toBeVisible();
      }
      await expect(
        page.getByRole("heading", { name: provider.provider === "slack" ? "Allowed Channels" : "Destinations" }),
      ).toBeVisible();
      if (provider.provider === "slack") {
        await page.locator("summary").filter({ hasText: "Message in a channel" }).click();
        await expect(page.getByText("@maya-paperclip you there?", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Allowed Channels" })).toBeVisible();
        await page.locator("summary").filter({ hasText: /^Agent avatar$/ }).click();
        const avatarSection = page.getByRole("region", { name: "Slack avatar" });
        await expect(avatarSection.getByRole("link", { name: "Download avatar" })).toBeVisible();
        await avatarSection.getByText("How to upload in Slack", { exact: true }).click();
        await expect(avatarSection.getByRole("link", { name: "Open Slack app Settings" })).toBeVisible();
        const settingsDownloadEvent = page.waitForEvent("download");
        await avatarSection.getByRole("link", { name: "Download avatar" }).click();
        expect((await settingsDownloadEvent).suggestedFilename()).toBe("maya-paperclip-avatar.png");
      }

      await expect(
        page.getByRole("switch", {
          name: `Enable ${provider.resourceLabel}`,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(provider.resourceLabel, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(provider.secondaryResourceLabel, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("switch", {
          name: `Enable ${provider.secondaryResourceLabel}`,
        }),
      ).not.toBeChecked();
      await page
        .getByRole("switch", { name: `Enable ${provider.resourceLabel}` })
        .click();
      await expect.poll(() => mock.updatedResource).toBe(true);
      expect(mock.resourceUpdates.at(-1)).toEqual([
        { id: `resource-${provider.provider}`, enabled: true },
      ]);

      if (provider.provider === "github") {
        await expect(
          page.getByRole("heading", { name: "Private conversations" }),
        ).toHaveCount(0);
      } else {
        const directMessages = page.getByRole("switch", {
          name: "Allow direct messages",
        });
        await expect(directMessages).toBeVisible();
        if (provider.provider === "discord") {
          await expect(
            page.getByText(
              "People must also enable Direct Messages in their shared Discord server’s Privacy Settings.",
            ),
          ).toBeVisible();
        }
        await directMessages.click();
        await expect.poll(() => mock.allowDirectMessages).toBe(true);
      }
      if (provider.provider === "microsoft-teams") {
        const groupChats = page.getByRole("switch", {
          name: "Allow group chats",
        });
        await expect(groupChats).toBeVisible();
        await groupChats.click();
        await expect.poll(() => mock.allowGroupChats).toBe(true);
      }
      for (const lifecycleAction of [
        "Pause",
        "Resume",
        "Reconnect",
        "Remove connection",
      ]) {
        await expect(
          page.getByRole("button", {
            name: lifecycleAction,
            exact: true,
          }),
        ).toHaveCount(0);
      }
      await expect(
        page.getByRole("switch", { name: "Allow unlinked people" }),
      ).toHaveCount(0);

      await page.getByRole("navigation", { name: "Chat connection" }).getByRole("link", { name: "Access", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "People" }),
      ).toBeVisible();
      if (provider.provider === "slack") {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
        await page.getByRole("button", { name: "Invite people", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Copy invitation" }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("connect");
        expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain("token=");
        await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      }
      await page.locator("summary").filter({ hasText: "Guest access" }).click();
      await expect(page.getByText(/Requests are refused when isolation is unavailable/)).toBeVisible();
      const allowUnlinked = page.getByRole("switch", {
        name: "Allow unlinked people",
      });
      await expect(allowUnlinked).toBeVisible();
      await allowUnlinked.click();
      await expect.poll(() => mock.allowUnlinkedPeople).toBe(true);
      await expect(
        page.getByText("Ada Lovelace", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Grace Hopper", { exact: true }),
      ).toBeVisible();

      await expect(
        page.getByRole("button", { name: "Create confirmation link" }),
      ).toBeVisible();
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(page.url()).origin,
        });
      await page.getByRole("button", { name: "Create confirmation link" }).click();
      await expect
        .poll(() => mock.linkIntentPrincipalId)
        .toBe(`principal-${provider.provider}`);
      const confirmationUrl = `https://paperclip.example.test/${seed.prefix}/chat-identity/confirm?token=e2e-redacted`;
      await expect(
        page.getByText(confirmationUrl, { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Copy link" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(confirmationUrl);
      await expect(
        page.getByText("Confirmation link copied", { exact: true }),
      ).toBeVisible();
      await page.getByRole("listitem").filter({ hasText: "Grace Hopper" }).getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect
        .poll(() => mock.revokedPrincipalId)
        .toBe(`principal-${provider.provider}-linked`);
      await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();

      await page.getByRole("navigation", { name: "Chat connection" }).getByRole("link", { name: "Conversations", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Conversations" }),
      ).toBeVisible();
      await expect(
        page.getByText(`Investigate ${provider.name} delivery`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(provider.resourceLabel, { exact: true }),
      ).toHaveCount(1);
      const providerLink = page.getByRole("link", {
        name: provider.resourceLabel,
      });
      await expect(providerLink).toHaveAttribute("href", provider.externalUrl);
      const taskLink = page.getByRole("link", { name: `Investigate ${provider.name} delivery` });
      await expect(taskLink).toHaveAttribute(
        "href",
        new RegExp(`/${seed.prefix}/issues/issue-${provider.provider}$`),
      );
      mock.conversationState = "waiting";
      await expect(page.getByText("waiting", { exact: true })).toBeVisible({
        timeout: 8_000,
      });

      await page.getByRole("navigation", { name: "Chat connection" }).getByRole("link", { name: "Activity", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Connection activity" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          `Inbound ${provider.name} delivery could not be processed`,
        ),
      ).toBeVisible();
      await expect(
        page.getByText(`Published safe output to ${provider.name}`),
      ).toBeVisible();
      await expect(page.getByText("Recent activity", { exact: true })).toBeVisible();
      await page.getByText("Connection health and controls", { exact: true }).click();
      const deliveryTimestamp = page
        .getByText(`Inbound ${provider.name} delivery could not be processed`)
        .locator("..")
        .locator("time");
      await expect(deliveryTimestamp).toHaveText(
        /\w+ \d+, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/,
      );
      await expect(deliveryTimestamp).toHaveAttribute(
        "datetime",
        /\d{4}-\d{2}-\d{2}T/,
      );
      await expect(deliveryTimestamp).toHaveAttribute(
        "title",
        (await deliveryTimestamp.getAttribute("datetime"))!,
      );
      await expect(page.getByText("xoxb-e2e-redacted")).toHaveCount(0);
      await expect(page.getByText("teams-client-secret")).toHaveCount(0);
      await expect(page.getByText("github-webhook-secret")).toHaveCount(0);

      // A provider callback does not cause a Board mutation. Keep this tab
      // mounted and focused: neither navigation nor Replay may refresh it.
      mock.liveActivitySummary = `${provider.name} reaction removed while viewing Activity`;
      mock.setStatus("paused");
      await expect(
        page.getByText(mock.liveActivitySummary, { exact: true }),
      ).toBeVisible({ timeout: 8_000 });
      await expect(
        page.getByRole("button", { name: "Resume", exact: true }),
      ).toBeVisible({ timeout: 8_000 });
      mock.setStatus("active");
      await expect(
        page.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible({ timeout: 8_000 });

      await page.getByRole("button", { name: "Replay" }).click();
      await expect.poll(() => mock.replayedDelivery).toBe(true);

      await expect(
        page.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Remove connection", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(PROVIDER_LIFECYCLE_COPY[provider.provider].reconnect, {
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Resume", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible();
      await expect.poll(() => mock.lifecycleActions).toEqual(["pause", "resume"]);

      mock.setStatus("attention");
      await page.reload();
      await page.getByText("Connection health and controls", { exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Reconnect", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Remove connection" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Reconnect", exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(
          `/${seed.prefix}/apps/chat/connect\\?.*resume=endpoint-${provider.provider}`,
        ),
      );
      expect(new URL(page.url()).searchParams.get("reconnect")).toBe("1");
      await expect(
        page.getByRole("heading", {
          name:
            provider.provider === "github"
              ? "Reconnect GitHub App"
              : provider.provider === "slack" ? "Add Slack credentials" : provider.setupHeading,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Choose an active agent" }),
      ).toHaveCount(0);

      if (provider.provider === "github") {
        const connectButton = page.getByRole("button", {
          name: provider.setupButton,
        });
        await expect(
          page.getByText(
            /Under the target user or organization, create a new GitHub App/,
          ),
        ).toHaveCount(0);
        await expect(
          page.getByText(
            /Leave App ID and private key blank to reuse saved credentials/,
          ),
        ).toBeVisible();
        await page.getByLabel("GitHub App ID").fill("123456");
        await page
          .getByLabel("Private key (PEM)")
          .fill("reconnect-private-key");
        await expect(connectButton).toBeEnabled();
        await page.evaluate((buttonName) => {
          const state = window as typeof window & {
            __githubConnectEnabledAfterRotation?: boolean;
          };
          state.__githubConnectEnabledAfterRotation = false;
          new MutationObserver(() => {
            const button = [...document.querySelectorAll("button")].find(
              (candidate) => candidate.textContent?.trim() === buttonName,
            );
            if (button instanceof HTMLButtonElement && !button.disabled) {
              state.__githubConnectEnabledAfterRotation = true;
            }
          }).observe(document.body, {
            attributes: true,
            childList: true,
            subtree: true,
          });
        }, provider.setupButton);
        await page
          .getByRole("button", { name: "Regenerate webhook secret" })
          .click();
        await expect(connectButton).toBeDisabled();
        await page.waitForTimeout(100);
        expect(
          await page.evaluate(
            () =>
              (
                window as typeof window & {
                  __githubConnectEnabledAfterRotation?: boolean;
                }
              ).__githubConnectEnabledAfterRotation,
          ),
        ).toBe(false);

        await page.goBack();
        await page.getByText("Connection health and controls", { exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "Connection activity" }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Reconnect", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Reconnect GitHub App" }),
        ).toBeVisible();
        await page.getByLabel("GitHub App ID").fill("123456");
        await page
          .getByLabel("Private key (PEM)")
          .fill("reconnect-private-key");
        await expect(
          page.getByRole("button", { name: provider.setupButton }),
        ).toBeDisabled();
        mock.setWebhookVerified();
        await expect(
          page.getByRole("button", { name: provider.setupButton }),
        ).toBeEnabled();
      }

      mock.setStatus("active");
      await page.goto(
        `/${seed.prefix}/apps/chat/endpoint-${provider.provider}/activity`,
      );
      await page.getByText("Connection health and controls", { exact: true }).click();
      await page.getByRole("button", { name: "Remove connection" }).click();
      const confirmation = page.getByRole("alertdialog");
      await expect(confirmation).toContainText("Remove this connection?");
      await expect(confirmation).toContainText(
        PROVIDER_LIFECYCLE_COPY[provider.provider].remove,
      );
      await confirmation
        .getByRole("button", { name: "Remove connection" })
        .click();
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`));
      await expect.poll(() => mock.removed).toBe(true);
      await expect.poll(() => mock.lifecycleActions).toEqual(["pause", "resume", "remove"]);
    });
  }
});

test.describe("iMessage Photon setup and management", () => {
  let seed: Seed;
  const photon: ProviderCase = {
    provider: "imessage-photon",
    slug: "imessage-photon",
    name: "iMessage Photon",
    accountLabel: "Photon Test",
    botLabel: "Maya",
    botUsername: "+15555550100",
    resourceLabel: "Family project",
    secondaryResourceLabel: "Second group",
    resourceType: "group_chat",
    externalUrl: "https://app.photon.codes/",
    setupHeading: /Connect iMessage Photon/,
    setupButton: "Connect selected number",
    chatAndTool: false,
  };
  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });
  test("connects Pro shared DMs without presenting a fake owned number or enabling groups", async ({page}) => {
    await installChatControlPlaneMock(page, photon, seed, { enableChatConnectors: true, photonShared: true });
    await page.goto(`/${seed.prefix}/apps`);
    await page.getByRole("button", {name:"Connect iMessage Photon",exact:true}).click();
    await selectMaya(page);
    await page.getByLabel("Project ID").fill("project-e2e");
    await page.getByLabel("Project secret").fill("photon-test-secret");
    await page.getByRole("button", {name:"Inspect Photon project"}).click();
    await expect(page.getByText(/Groups cannot be enabled on this channel/)).toBeVisible();
    await page.getByRole("button", {name:"Connect shared DMs"}).click();
    await expect(page.getByRole("heading", {name:"Try Maya in iMessage Photon"})).toBeVisible();
    await page.reload();
    await expect(page.getByText(/enroll your sender in Users/)).toBeVisible();
    await expect(page.getByRole("button", {name:/Copy \+1555/})).toHaveCount(0);
    await page.getByRole("button", {name:"I've sent the test message"}).click();
    await page.getByRole("navigation", { name: "Chat connection" }).getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByText(/Shared Photon project · direct messages only/)).toBeVisible();
    await expect(page.getByRole("switch", {name:"Enable Family project"})).toBeDisabled();
    await expect(page.getByRole("button", {name:"Copy dedicated number"})).toHaveCount(0);
  });
  for (const theme of ["light", "dark"] as const) {
    test(`discovers dedicated lines and completes the channel wizard (${theme})`, async ({
      page,
    }, testInfo) => {
      const mock = await installChatControlPlaneMock(page, photon, seed, {
        enableChatConnectors: true,
      });
      await page.addInitScript(
        (value) => localStorage.setItem("paperclip.theme", value),
        theme,
      );
      await page.goto(`/${seed.prefix}/apps`);
      const card = await findConnectorBySearch(page, "iMessage Photon", "imessage-photon");
      await card
        .getByRole("button", { name: "Connect iMessage Photon" })
        .click();
      await selectMaya(page);
      await expectSetupRail(page);
      await expect(
        page.getByRole("heading", { name: "Connect iMessage Photon" }),
      ).toBeVisible();
      await page.getByLabel("Project ID").fill("project-e2e");
      await page.getByLabel("Project secret").fill("photon-test-secret");
      await expect(page.getByLabel("Project secret")).toHaveAttribute(
        "type",
        "password",
      );
      await page
        .getByRole("button", { name: "Inspect Photon project" })
        .click();
      await expect(
        page.getByRole("button", { name: "Connect selected number" }),
      ).toBeDisabled();
      await page
        .getByRole("radio", { name: "+15555550100", exact: true })
        .focus();
      await page.keyboard.press("Space");
      await page
        .getByRole("button", { name: "Connect selected number" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Try Maya in iMessage Photon" }),
      ).toBeVisible();
      expect(mock.configuredCredentialKeys).toEqual(["projectSecret"]);
      await expect(
        page.getByRole("button", { name: "Copy +15555550100" }),
      ).toBeVisible();
      await expect(
        page.getByText("Link your Messages identity", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "I've sent the test message" })
        .click();
      await page.getByRole("navigation", { name: "Chat connection" }).getByRole("link", { name: "Settings", exact: true }).click();
      await expect(
        page.getByText(/replies are visible to everyone in that group/),
      ).toBeVisible();
      const group = page.getByRole("switch", { name: "Enable Family project" });
      await expect(group).not.toBeChecked();
      await group.click();
      await expect(group).toBeChecked();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Open sidebar" }).click();
      await page.getByRole("navigation", { name: "Chat connection" }).getByRole("link", { name: "Activity", exact: true }).click();
      await page.getByText("Connection health and controls", { exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`photon-${theme}-mobile.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Resume", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible();
    });
  }
});
