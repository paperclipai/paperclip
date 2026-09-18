import { expect, test, type Page } from "@playwright/test";

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
} from "./chat-adapters-ui.shared";

/**
 * Native chat-connector provider setup coverage: adapter install/lifecycle
 * flows and the iMessage Photon variant. Shared fixtures and the
 * chat-control-plane mock live in ./chat-adapters-ui.shared.ts; the
 * messaging-flow describes run in chat-adapters-ui-messaging.spec.ts.
 */
test.describe.serial("native chat adapter UI", () => {
  test.setTimeout(180_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });

  test("GitHub: the default-off gate keeps direct tool setup and fences chat routes", async ({
    page,
  }) => {
    const github = PROVIDERS.find(
      (provider) => provider.provider === "github",
    )!;
    const mock = await installChatControlPlaneMock(page, github, seed, {
      enableChatConnectors: false,
    });

    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible(
      { timeout: 30_000 },
    );
    const connector = page.locator(
      `[role="listitem"][data-app-slug="${github.slug}"]`,
    );
    await expect(connector).toBeVisible();
    await connector.getByRole("button", { name: "Connect GitHub" }).click();

    await expect(page).toHaveURL(/\/apps\/connect\?/);
    expect(new URL(page.url()).searchParams.get("source")).toBe("github");
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
    await expect.poll(() => mock.chatEndpointListReads).toBe(0);
    expect(mock.createdWithAgentId).toBeNull();
  });

  for (const enabled of [false, true]) {
    test(`Agent Channels: one heading and current experiment gate (${enabled})`, async ({
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
      if (enabled) {
        await expect(page).toHaveURL(/\/channels$/);
        await expect(channelsHeading).toHaveCount(1);
        await expect(channelsHeading).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Connect a channel" }),
        ).toBeVisible();
        await expect.poll(() => mock.chatEndpointListReads).toBeGreaterThan(0);
      } else {
        await expect(page).toHaveURL(/\/overview$/);
        await expect(channelsHeading).toHaveCount(0);
        await expect(
          page.getByRole("link", { name: "Channels", exact: true }),
        ).toHaveCount(0);
        expect(mock.chatEndpointListReads).toBe(0);
      }
    });
  }

  for (const provider of PROVIDERS) {
    test(`${provider.name}: catalog, setup, and connection management tabs`, async ({
      page,
    }) => {
      const mock = await installChatControlPlaneMock(page, provider, seed, {
        enableChatConnectors: true,
      });

      await page.goto(`/${seed.prefix}/apps`);
      await expect(
        page.getByRole("heading", { name: "Connectors" }),
      ).toBeVisible({ timeout: 30_000 });
      const connector = page.locator(
        `[role="listitem"][data-app-slug="${provider.slug}"]`,
      );
      await expect(connector).toBeVisible({ timeout: 30_000 });
      await connector
        .getByRole("button", { name: `Connect ${provider.name}` })
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
        if (provider.provider === "github") {
          await expect(
            page.getByRole("heading", { name: "Connect GitHub as" }),
          ).toBeVisible();
          await expect(
            page.getByText("Chat with an agent", { exact: true }),
          ).toHaveCount(0);
        }
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

      await expect(
        page.getByRole("heading", {
          name: "Which agent do you want to chat with?",
        }),
      ).toBeVisible();
      await expectSetupRail(page);
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
        await expect(
          page.getByRole("heading", { name: "Finish Slack setup" }),
        ).toBeVisible();
        await expect(
          page.getByText(
            `https://paperclip.example.test/api/chat-webhooks/public-slack/slack`,
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.getByText("/maya-public", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(
            /Slack's bare \/status command is not a Paperclip control/,
          ),
        ).toBeVisible();
        const saveChangesStep = page
          .getByRole("listitem")
          .filter({ hasText: "Save Changes" });
        await expect(saveChangesStep).toHaveCount(1);
        await expect(
          saveChangesStep.locator("..").getByRole("listitem"),
        ).toHaveCount(1);
        await expect(saveChangesStep).toHaveText(
          "Return to App Manifest in Slack and click Save Changes. The copied manifest already contains the event, interaction, and slash-command URLs. Slack verifies the Events URL when you save; Paperclip records Interactivity and slash command health only after each signed callback is observed.",
        );
        for (const removedManualStep of [
          "Event Subscriptions",
          "Interactivity & Shortcuts",
          "Slash Commands",
        ]) {
          await expect(
            page.getByText(removedManualStep, { exact: true }),
          ).toHaveCount(0);
        }
        await page
          .getByRole("button", { name: "Start Slack message test" })
          .click();
      }

      await expect(
        page.getByRole("heading", { name: `Try Maya in ${provider.name}` }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "I've sent the test message" }),
      ).toBeVisible();
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
      await expectSetupRail(page);
      await expectProviderTryInstructions(page, provider);
      expect(mock.configuredCredentialKeys).toEqual(
        expectedCredentialKeys(provider.provider),
      );
      await page
        .getByRole("button", { name: "I've sent the test message" })
        .click();

      await expect(page).toHaveURL(
        new RegExp(
          `/${seed.prefix}/apps/chat/endpoint-${provider.provider}/settings$`,
        ),
      );
      await expect(
        page.getByRole("heading", { name: `Maya in ${provider.name}` }),
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
      await expect(page.getByRole("tab")).toHaveCount(4);
      for (const tab of ["Settings", "Access", "Conversations", "Activity"]) {
        await expect(page.getByRole("tab", { name: tab })).toBeVisible();
      }
      await expect(
        page.getByRole("heading", { name: "Where this agent can work" }),
      ).toBeVisible();
      if (provider.provider === "slack") {
        await expect(
          page.getByRole("heading", { name: "Slack command" }),
        ).toBeVisible();
        await expect(
          page.getByText("/maya-public", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(
            /Slack's bare \/status command is not a Paperclip control/,
          ),
        ).toBeVisible();
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

      await page.getByRole("tab", { name: "Access" }).click();
      await expect(
        page.getByRole("heading", { name: "External identity access" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          /Their tasks run only with an isolated workspace and sandbox environment; otherwise Paperclip safely refuses the request/,
        ),
      ).toBeVisible();
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
        page.getByText("Linked to Grace Hopper", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create private link" }),
      ).toBeVisible();
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(page.url()).origin,
        });
      await page.getByRole("button", { name: "Create private link" }).click();
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
      await page.getByRole("button", { name: "Revoke" }).click();
      await expect
        .poll(() => mock.revokedPrincipalId)
        .toBe(`principal-${provider.provider}-linked`);
      await expect(
        page.getByText(`grace@${provider.provider}`, { exact: true }),
      ).toBeVisible();

      await page.getByRole("tab", { name: "Conversations" }).click();
      await expect(
        page.getByRole("heading", { name: "Conversations" }),
      ).toBeVisible();
      await expect(
        page.getByText(`CHAT-123 · Investigate ${provider.name} delivery`),
      ).toBeVisible();
      await expect(
        page.getByText(provider.resourceLabel, { exact: true }),
      ).toHaveCount(1);
      const providerLink = page.getByRole("link", {
        name: `Open ${provider.name}`,
      });
      await expect(providerLink).toHaveAttribute("href", provider.externalUrl);
      const taskLink = page.getByRole("link", { name: "Open task" });
      await expect(taskLink).toHaveAttribute(
        "href",
        new RegExp(`/${seed.prefix}/issues/issue-${provider.provider}$`),
      );
      mock.conversationState = "waiting";
      await expect(page.getByText("waiting", { exact: true })).toBeVisible({
        timeout: 8_000,
      });

      await page.getByRole("tab", { name: "Activity" }).click();
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
      await expect(
        page.getByText("Credential values and request bodies are redacted."),
      ).toBeVisible();
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
      expect(mock.lifecycleActions).toEqual(["pause", "resume"]);

      mock.setStatus("attention");
      await page.reload();
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
              : provider.setupHeading,
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
        mock.setGitHubWebhookVerified();
        await expect(
          page.getByRole("button", { name: provider.setupButton }),
        ).toBeEnabled();
      }

      mock.setStatus("active");
      await page.goto(
        `/${seed.prefix}/apps/chat/endpoint-${provider.provider}/activity`,
      );
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
      expect(mock.lifecycleActions).toEqual(["pause", "resume", "remove"]);
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
    await page.getByRole("tab", {name:"Settings"}).click();
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
      const card = page.locator(
        '[role="listitem"][data-app-slug="imessage-photon"]',
      );
      await expect(card).toBeVisible();
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
      await page.getByRole("tab", { name: "Settings" }).click();
      await expect(
        page.getByText(/replies are visible to everyone in that group/),
      ).toBeVisible();
      const group = page.getByRole("switch", { name: "Enable Family project" });
      await expect(group).not.toBeChecked();
      await group.click();
      await expect(group).toBeChecked();
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByRole("combobox", { name: "Page section" })
        .selectOption("activity");
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
