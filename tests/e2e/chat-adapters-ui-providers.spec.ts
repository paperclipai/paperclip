import { oauthCallbackInterstitialHtml } from "../../server/src/lib/oauth-browser-return";
import { createServer } from "node:http";
import { expect, test, type Page } from "@playwright/test";

import {
  expectSetupRail,
  installChatControlPlaneMock,
  seedCompanyAndAgent,
  selectMaya,
  PROVIDERS,
  type ProviderCase,
  type Seed,
} from "./chat-adapters-ui.shared";

async function expectCompletedSlackSetupCloses(page: Page, seed: Seed) {
  let finishRequests = 0;
  await page.route("**/api/chat-endpoints/endpoint-slack/finish", async route => {
    finishRequests++;
    await route.fulfill({ status: 409, json: { error: "This connection is not waiting for a setup test" } });
  });
  await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&toolHref=%2Fapps%2Fconnect%3Fsource%3Dslack&resume=endpoint-slack`);
  await expect(page.getByRole("heading", { name: "Success", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Slack", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL(/\/apps\/chat\/endpoint-slack\/settings$/);
  await page.reload();
  await expect(page.getByRole("link", { name: "Open Slack", exact: true })).toBeVisible();
  expect(finishRequests).toBe(0);
}

async function findConnectorBySearch(page: Page, query: string, slug: string) {
  const search = page.getByRole("searchbox", { name: "Search connectors" });
  await expect(search).toBeVisible();
  await search.fill(query);
  const connector = page.locator(`[role="listitem"][data-app-slug="${slug}"]`);
  await expect(connector).toBeVisible({ timeout: 30_000 });
  return connector;
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

test.describe("native chat adapter UI", () => {
  test.setTimeout(180_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });

  test("Slack: managed workspace setup has two stops, resumes and completes without pasting credentials", async ({ page }) => {
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    const mock = await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, managedSlack: true });
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat`);
    await selectMaya(page);
    await expect(page.getByRole("navigation", { name: "Connection setup progress" }).getByRole("button")).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Send a message to your agent", exact: true })).toBeVisible();
    await expect(page.getByLabel("App configuration access token", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Signing Secret", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Send a message to your agent", exact: true })).toBeVisible();
    expect(mock.slackCreations).toBe(1); expect(mock.slackInstallations).toBe(1);
    mock.setWebhookVerified();
    await expect(page.getByRole("heading", { name: "Success", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Connection setup progress" }).getByRole("button")).toHaveCount(2);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/chat\/endpoint-slack\/settings$/);
    await expectCompletedSlackSetupCloses(page, seed);
    expect(mock.slackCreations).toBe(1); expect(mock.slackInstallations).toBe(1);
  });
  test("Slack: a failed manager refresh opens workspace authorization in a separate tab", async ({ page }) => {
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, managedSlack: true });
    let refreshFailed = false;
    let authorizationRequests = 0;
    await page.route("**/chat-slack/setup-options", async route => {
      if (!refreshFailed) return route.fallback();
      await route.fulfill({ json: { managedAvailable: true, defaultMethod: "managed", workspaces: [] } });
    });
    await page.route("**/slack/managed/provision", async route => {
      refreshFailed = true;
      await route.fulfill({ status: 422, json: { error: "Reconnect your Slack workspace.", details: { code: "slack_manager_reauthorize" } } });
    });
    await page.route("**/slack/managed/authorize", async route => {
      authorizationRequests++;
      await route.fulfill({ json: { authorizationUrl: "https://slack.test/manager-consent", expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    });
    await page.context().route("https://slack.test/manager-consent", route => route.fulfill({ contentType: "text/html", body: "Slack authorization fixture" }));
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-slack`);
    await expect(page.getByRole("alert")).toBeVisible();
    const authorizationOpened = page.context().waitForEvent("page");
    await page.getByRole("button", { name: "Reconnect Slack workspace", exact: true }).click();
    const authorizationPage = await authorizationOpened;
    await expect.poll(() => authorizationRequests).toBe(1);
    await expect(authorizationPage).toHaveURL("https://slack.test/manager-consent");
    await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps/chat/connect\\?provider=slack`));
    await authorizationPage.close();
  });
  test("Slack: every uncertain creation retry needs a fresh confirmation", async ({ page }) => {
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    const mock = await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, managedSlack: true });
    mock.setSlackUncertain();
    const attempts: { requestId: string; confirmedNoAppCreated?: boolean }[] = [];
    await page.route("**/slack/managed/provision", async route => {
      attempts.push(route.request().postDataJSON());
      await route.fulfill({ json: {} });
    });
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-slack`);
    const confirm = page.getByRole("checkbox", { name: "I checked Slack and no app was created. Create a new app." });
    const create = page.getByRole("button", { name: "Continue", exact: true });
    await expect(create).toBeDisabled();
    await confirm.check(); await create.click();
    await expect(confirm).not.toBeChecked(); await expect(create).toBeDisabled();
    expect(attempts).toHaveLength(1); expect(attempts[0]!.confirmedNoAppCreated).toBe(true);
    await confirm.check(); await create.click();
    await expect(confirm).not.toBeChecked(); await expect(create).toBeDisabled();
    expect(attempts).toHaveLength(2); expect(attempts[1]!.requestId).not.toBe(attempts[0]!.requestId);
  });
  test("Slack: own-app creation consumes confirmation even when the response is lost", async ({ page }) => {
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    const mock = await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, automaticSlack: true });
    mock.setSlackUncertain();
    let attempts = 0;
    await page.route("**/slack/registration", async route => {
      attempts++; expect(route.request().postDataJSON().confirmedNoAppCreated).toBe(true);
      await route.fulfill({ status: 502, json: { error: "Creation response unavailable" } });
    });
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-slack`);
    const confirm = page.getByRole("checkbox");
    await confirm.check();
    await page.getByLabel("App configuration access token", { exact: true }).fill("fixture-config-token");
    await page.getByRole("button", { name: "Create Slack app", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(confirm).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Create Slack app", exact: true })).toBeDisabled();
    expect(attempts).toBe(1);
  });
  test("Slack: temporarily unavailable managed setup can retry in place", async ({ page }) => {
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, managedSlack: true });
    let available = false;
    await page.route("**/chat-slack/setup-options", async route => {
      if (available) return route.fallback();
      await route.fulfill({ json: { managedAvailable: false, defaultMethod: "automatic", workspaces: [] } });
    });
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat&resume=endpoint-slack`);
    await expect(page.getByText("Managed Slack setup is unavailable. Try again later.")).toBeVisible();
    const retryButton = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retryButton).toBeEnabled();
    available = true;
    await retryButton.click();
    await expect(page.getByRole("heading", { name: "Send a message to your agent", exact: true })).toBeVisible();
  });
  test("Slack: own-app selection persists before provisioning", async ({ page }) => {
    const slack = PROVIDERS.find(provider => provider.provider === "slack")!;
    await installChatControlPlaneMock(page, slack, seed, { enableChatConnectors: true, managedSlack: true });
    await page.goto(`/${seed.prefix}/apps/chat/connect?provider=slack&purpose=chat`);
    await page.getByRole("button", { name: "Choose an active agent" }).click();
    await page.getByRole("button", { name: "Select Maya" }).click();
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByRole("button", { name: "Use your own app" }).click();
    await expect(page.getByRole("heading", { name: "App configuration access token", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "App configuration access token", exact: true })).toBeVisible();
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByRole("button", { name: "Use managed setup" }).click();
    await expect(page.getByRole("heading", { name: "Send a message to your agent", exact: true })).toBeVisible();
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
    await page.context().route("**/api/chat-slack/oauth/callback?**", async route => {
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
    const retryWindowOpened = page.context().waitForEvent("page");
    try {
      await page.getByRole("button", { name: "Install in Slack", exact: true }).click();
      await installation.requested;
      await expectNavigationLocked();
    } finally { installation.release(); }
    const retryConsentWindow = await retryWindowOpened;
    await expect(retryConsentWindow.getByRole("heading", { name: "Fixture Slack consent" })).toBeVisible();
    await expect(page).toHaveURL(rootUrl);
    await retryConsentWindow.getByRole("link", { name: "Approve installation" }).click();
    await expect.poll(() => callbackRequests).toBe(2);
    await expect(retryConsentWindow).toHaveURL(rootUrl);
    await retryConsentWindow.close();
    await page.bringToFront();
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
    await expectCompletedSlackSetupCloses(page, seed);
    expect(mock.slackCreations).toBe(1); expect(mock.slackInstallations).toBe(2);
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
      const agentNavigation = page.getByRole("navigation", { name: "Maya navigation" });
      await expect(agentNavigation.getByRole("link", { name: "Identity", exact: true })).toBeVisible();
      await expect(agentNavigation.getByRole("link", { name: "Channels", exact: true })).toHaveCount(0);
      await expect.poll(() => mock.chatEndpointListReads).toBeGreaterThan(0);
      if (!enabled) {
        await expect(page.getByText("Connect AgentMail from Connectors.", { exact: true })).toBeVisible();
      }
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
