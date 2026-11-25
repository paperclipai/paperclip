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
  const search = page.getByRole("searchbox", { name: "Search plugins" });
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
  await page.getByLabel("Private key", { exact: true }).evaluate((element, privateKey) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", privateKey);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, GITHUB_PRIVATE_KEY_PASTE_FIXTURE);
  await page.getByLabel("Webhook secret", { exact: true }).fill("github-webhook-secret");
  const rejectedAppResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat-endpoints/endpoint-github/github/app") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Connect existing App", exact: true }).click();
  expect((await rejectedAppResponse).request().postDataJSON().privateKey).toBe(GITHUB_PRIVATE_KEY_PASTE_FIXTURE);
  await expect(page.getByRole("alert")).toContainText("GitHub rejected the supplied App credentials.");
  await expect(page.getByLabel("Private key", { exact: true })).toHaveValue("");
  await expect(page.getByText("Private key loaded. Paste or upload another key to replace it.", { exact: true })).toBeVisible();
  const retriedAppResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat-endpoints/endpoint-github/github/app") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Connect existing App", exact: true }).click();
  expect((await retriedAppResponse).request().postDataJSON().privateKey).toBe(GITHUB_PRIVATE_KEY_PASTE_FIXTURE);
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
  const recoveryNotice = page.getByRole("region", { name: "GitHub connection needs repair" });
  await expect(recoveryNotice).toBeVisible();
  await recoveryNotice.getByRole("link", { name: "Reconnect GitHub", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reconnect GitHub", exact: true })).toBeVisible();
  await expect(page.getByText(/using its saved credentials/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose an agent", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Private key", { exact: true })).toHaveCount(0);
  const reconnectResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/chat-endpoints/endpoint-github/setup") &&
    response.request().method() === "POST" &&
    response.request().postDataJSON().action === "reconnect",
  );
  await page.getByRole("button", { name: "Reconnect saved App", exact: true }).click();
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
 * Per-provider catalog, setup, and connection management tab flows across
 * Slack, GitHub, Microsoft Teams, Discord, and Telegram. Split from
 * chat-adapters-ui-providers.spec.ts to keep every E2E spec under 1,000 LOC
 * and under the 180s per-file CI budget.
 */
test.describe("native chat adapter UI catalog and management", () => {
  test.setTimeout(180_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });

  for (const provider of PROVIDERS) {
    test(`${provider.name}: catalog, setup, and connection management tabs`, async ({
      page,
    }, testInfo) => {
      const mock = await installChatControlPlaneMock(page, provider, seed, {
        enableChatConnectors: provider.provider !== "github",
      });

      await page.goto(`/${seed.prefix}/apps`);
      await expect(
        page.getByRole("heading", { name: "Plugins" }),
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
      if (provider.provider === "slack") {
        await page.getByText("Advanced", { exact: true }).click();
        await page.getByRole("button", { name: "Create manually", exact: true }).click();
      }
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
        await expect(page.getByRole("heading", { name: "Allowed Channels" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Send me a test message" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Open Slack configuration" })).toBeVisible();
        await expect(page.getByText("Message in a channel", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Agent avatar", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("link", { name: "View message" })).toHaveCount(0);
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
        page.getByRole("list", { name: "Conversations", exact: true }),
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
          name: provider.provider === "slack" ? "Add Slack credentials" : provider.setupHeading,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Choose an active agent" }),
      ).toHaveCount(0);

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
