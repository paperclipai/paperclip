import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Route,
} from "@playwright/test";

/**
 * Deterministic browser coverage for the native chat-connector UI.
 *
 * Provider APIs are deliberately not contacted here. The shared Paperclip
 * server supplies the company, agent, and connector catalog, while a small
 * stateful route fixture emulates the chat-control-plane responses. Live
 * provider webhook and credential qualification belongs in the manual runbook
 * because those checks require real accounts and publicly reachable ingress.
 */

type Provider = "slack" | "github" | "discord" | "microsoft-teams" | "telegram";

type ProviderCase = {
  provider: Provider;
  slug: string;
  name: string;
  accountLabel: string;
  botLabel: string;
  botUsername: string;
  resourceLabel: string;
  secondaryResourceLabel: string;
  resourceType: string;
  externalUrl: string;
  setupHeading: RegExp;
  setupButton: string;
  chatAndTool: boolean;
};

const PROVIDERS: ProviderCase[] = [
  {
    provider: "slack",
    slug: "slack",
    name: "Slack",
    accountLabel: "Acme Workspace",
    botLabel: "Maya",
    botUsername: "maya-paperclip",
    resourceLabel: "#product",
    secondaryResourceLabel: "#support",
    resourceType: "channel",
    externalUrl: "https://app.slack.com/client/T-E2E/C-E2E/thread/C-E2E-1",
    setupHeading: /Connect a Slack app/i,
    setupButton: "Connect Slack app",
    chatAndTool: true,
  },
  {
    provider: "github",
    slug: "github",
    name: "GitHub",
    accountLabel: "paperclip-ai",
    botLabel: "Maya",
    // GitHub's API returns the actor login with this suffix, while people
    // invoke the App with the bare slug.
    botUsername: "maya-paperclip[bot]",
    resourceLabel: "paperclip-ai/paperclip",
    secondaryResourceLabel: "paperclip-ai/chat-e2e",
    resourceType: "repository",
    externalUrl: "https://github.com/paperclip-ai/paperclip/issues/123",
    setupHeading: /Create or connect a GitHub App/i,
    setupButton: "Connect and verify",
    chatAndTool: true,
  },
  {
    provider: "microsoft-teams",
    slug: "microsoft-teams",
    name: "Microsoft Teams",
    accountLabel: "Acme Tenant",
    botLabel: "Maya",
    botUsername: "maya-paperclip",
    resourceLabel: "Product / General",
    secondaryResourceLabel: "Product / Incidents",
    resourceType: "channel",
    externalUrl: "https://teams.microsoft.com/l/message/19:e2e@thread.tacv2/1",
    setupHeading: /Connect Maya to Microsoft Teams/i,
    setupButton: "Verify Microsoft credentials",
    chatAndTool: false,
  },
  {
    provider: "discord",
    slug: "discord",
    name: "Discord",
    accountLabel: "Clawd",
    botLabel: "Maya",
    botUsername: "maya-paperclip",
    resourceLabel: "#general",
    secondaryResourceLabel: "#support",
    resourceType: "channel",
    externalUrl:
      "https://discord.com/channels/1457808928258658549/1457808933082108089",
    setupHeading: /Connect Maya to Discord/i,
    setupButton: "Connect Discord bot",
    chatAndTool: false,
  },
  {
    provider: "telegram",
    slug: "telegram",
    name: "Telegram",
    accountLabel: "@maya_paperclip_bot",
    botLabel: "Maya",
    botUsername: "maya_paperclip_bot",
    resourceLabel: "Maya test chat",
    secondaryResourceLabel: "Maya group chat",
    resourceType: "direct_message",
    externalUrl: "https://t.me/maya_paperclip_bot",
    setupHeading: /Create Maya in Telegram/i,
    setupButton: "Connect bot",
    chatAndTool: false,
  },
];

const PROVIDER_LIFECYCLE_COPY: Record<
  Provider,
  { reconnect: string; remove: string }
> = {
  slack: {
    reconnect:
      "Reconnect verifies or replaces credentials for this same Slack app. It does not reinstall the app or change its workspace or channel membership.",
    remove: "It does not uninstall the Slack app",
  },
  github: {
    reconnect:
      "Reconnect verifies this same GitHub App and installation. It does not reinstall the App or change repository access.",
    remove: "It does not uninstall the GitHub App",
  },
  discord: {
    reconnect:
      "Reconnect verifies this same Discord application and server installation. It does not add or remove the bot from the server.",
    remove: "It does not uninstall the bot",
  },
  "microsoft-teams": {
    reconnect:
      "Reconnect verifies this same Microsoft app, tenant, and bot identity. It does not upload or reinstall the Teams app.",
    remove: "It does not uninstall the Teams app",
  },
  telegram: {
    reconnect:
      "Reconnect verifies this same BotFather bot and automatically refreshes its Paperclip webhook and command menu.",
    remove:
      "queues durable removal of its Telegram webhook and command menu. After Telegram confirms that cleanup, Paperclip retires the saved token",
  },
};

type Seed = {
  companyId: string;
  prefix: string;
  agentId: string;
  otherAgentId: string;
};

async function json<T>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  label: string,
): Promise<T> {
  expect(
    response.ok(),
    `${label} failed ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as T;
}

async function seedCompanyAndAgent(request: APIRequestContext): Promise<Seed> {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", {
      data: { name: `Chat adapters browser E2E ${Date.now()}` },
    }),
    "create company",
  );
  const agent = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Maya",
        role: "qa",
        title: "Chat connector test agent",
        capabilities: "Exercises deterministic chat connector browser flows.",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["--input-type=module", "-e", "process.exit(0)"],
        },
      },
    }),
    "create agent",
  );
  const otherAgent = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Nora",
        role: "qa",
        title: "Second chat connector test agent",
        capabilities: "Proves a chat connection keeps its chosen agent.",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["--input-type=module", "-e", "process.exit(0)"],
        },
      },
    }),
    "create second agent",
  );
  return {
    companyId: company.id,
    prefix: company.issuePrefix,
    agentId: agent.id,
    otherAgentId: otherAgent.id,
  };
}

function bodyOf(route: Route): Record<string, unknown> {
  return route.request().postDataJSON() as Record<string, unknown>;
}

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function endpointFixture(provider: ProviderCase, seed: Seed) {
  const now = new Date().toISOString();
  return {
    id: `endpoint-${provider.provider}`,
    companyId: seed.companyId,
    connectionId: `connection-${provider.provider}`,
    provider: provider.provider,
    publicId: `public-${provider.provider}`,
    status: "draft",
    deploymentMode: "direct",
    assignedAgentId: seed.agentId,
    assignedAgentName: "Maya",
    sponsorUserId: null,
    providerAccountId: null,
    providerAccountLabel: null,
    botExternalId: null,
    botUsername: null,
    botLabel: null,
    allowDirectMessages: false,
    allowGroupChats: false,
    allowUnlinkedPeople: false,
    replyMode: "subscribed",
    capabilities: {
      threads: provider.provider !== "telegram",
      directMessages: provider.provider !== "github",
      nativeStreaming:
        provider.provider === "slack" || provider.provider === "telegram",
      messageEdits: true,
      messageDeletes:
        provider.provider === "slack" ||
        provider.provider === "github" ||
        provider.provider === "discord",
      reactions: true,
      files: true,
      cards:
        provider.provider === "slack" ||
        provider.provider === "microsoft-teams",
      actions: true,
      modals: false,
      slashCommands:
        provider.provider !== "github" && provider.provider !== "discord",
      ephemeralMessages:
        provider.provider === "slack" ||
        provider.provider === "microsoft-teams",
      proactiveDirectMessages: false,
    },
    setup: {
      step: "provider_setup",
      authorizationUrl:
        provider.provider === "telegram"
          ? "https://t.me/BotFather"
          : provider.provider === "microsoft-teams"
            ? "https://dev.teams.microsoft.com/apps"
            : provider.provider === "github"
              ? "https://github.com/settings/apps"
              : provider.provider === "discord"
                ? "https://discord.com/developers/applications"
                : "https://api.slack.com/apps",
      providerUrl: provider.externalUrl,
      webhookUrl: `https://paperclip.example.test/api/chat-webhooks/public-${provider.provider}/${provider.provider}`,
      messagingEndpoint: `https://paperclip.example.test/api/chat-webhooks/public-${provider.provider}/microsoft-teams`,
      command: provider.provider === "slack" ? "/maya-public" : undefined,
      webhookVerifiedAt: null,
      webhookSecretConfigured: false,
    },
    healthMessage: null,
    lastActivityAt: now,
    lastPublicationAt: now,
    activatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

type ChatMock = {
  createdWithAgentId: string | null;
  configuredCredentialKeys: string[];
  updatedResource: boolean;
  resourceUpdates: Array<Array<{ id: string; enabled: boolean }>>;
  allowDirectMessages: boolean | null;
  allowGroupChats: boolean | null;
  allowUnlinkedPeople: boolean | null;
  linkIntentPrincipalId: string | null;
  revokedPrincipalId: string | null;
  lifecycleActions: string[];
  replayedDelivery: boolean;
  removed: boolean;
  setStatus: (status: string) => void;
};

async function installChatControlPlaneMock(
  page: Page,
  provider: ProviderCase,
  seed: Seed,
): Promise<ChatMock> {
  const endpoint = endpointFixture(provider, seed);
  const state: ChatMock & { created: boolean } = {
    created: false,
    createdWithAgentId: null,
    configuredCredentialKeys: [],
    updatedResource: false,
    resourceUpdates: [],
    allowDirectMessages: null,
    allowGroupChats: null,
    allowUnlinkedPeople: null,
    linkIntentPrincipalId: null,
    revokedPrincipalId: null,
    lifecycleActions: [],
    replayedDelivery: false,
    removed: false,
    setStatus: (status) => {
      endpoint.status = status;
    },
  };
  const resource = {
    id: `resource-${provider.provider}`,
    companyId: seed.companyId,
    endpointId: endpoint.id,
    type: provider.resourceType,
    providerResourceId: `provider-resource-${provider.provider}`,
    label: provider.resourceLabel,
    detail:
      provider.provider === "github" ? "Repository" : "Available at provider",
    providerUrl: provider.externalUrl,
    availability: "available",
    enabled: false,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
  const secondaryResource = {
    ...resource,
    id: `resource-${provider.provider}-secondary`,
    providerResourceId: `provider-resource-${provider.provider}-secondary`,
    label: provider.secondaryResourceLabel,
    detail:
      provider.provider === "github" ? "Repository" : "Available at provider",
  };
  const resources = [resource, secondaryResource];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (pathname === `/api/companies/${seed.companyId}/chat-endpoints`) {
      if (method === "GET") {
        await fulfill(route, { endpoints: state.created ? [endpoint] : [] });
        return;
      }
      if (method === "POST") {
        const body = bodyOf(route);
        expect(body).toMatchObject({
          provider: provider.provider,
          assignedAgentId: seed.agentId,
        });
        state.createdWithAgentId = String(body.assignedAgentId);
        state.created = true;
        await fulfill(route, endpoint, 201);
        return;
      }
    }

    if (pathname === `/api/chat-endpoints/${endpoint.id}`) {
      if (method === "GET") {
        await fulfill(route, endpoint);
        return;
      }
      if (method === "PATCH") {
        const body = bodyOf(route);
        if (typeof body.allowDirectMessages === "boolean")
          state.allowDirectMessages = body.allowDirectMessages;
        if (typeof body.allowGroupChats === "boolean")
          state.allowGroupChats = body.allowGroupChats;
        if (typeof body.allowUnlinkedPeople === "boolean")
          state.allowUnlinkedPeople = body.allowUnlinkedPeople;
        Object.assign(endpoint, body, {
          updatedAt: new Date().toISOString(),
        });
        await fulfill(route, endpoint);
        return;
      }
    }

    if (
      pathname === `/api/chat-endpoints/${endpoint.id}/setup-secret` &&
      method === "POST"
    ) {
      endpoint.setup.webhookSecretConfigured = true;
      endpoint.setup.webhookVerifiedAt = new Date().toISOString();
      await fulfill(route, { webhookSecret: "github-webhook-secret" }, 201);
      return;
    }

    if (
      pathname === `/api/chat-endpoints/${endpoint.id}/setup` &&
      method === "POST"
    ) {
      const body = bodyOf(route);
      const action = String(body.action);
      if (action === "pause" || action === "resume" || action === "remove") {
        state.lifecycleActions.push(action);
        if (action === "pause") endpoint.status = "paused";
        if (action === "resume") endpoint.status = "active";
        if (action === "remove") {
          endpoint.status = "archived";
          state.created = false;
          state.removed = true;
        }
        await fulfill(route, endpoint);
        return;
      }
      expect(["configure", "verify"]).toContain(action);
      if (body.action === "configure") {
        state.configuredCredentialKeys = Object.keys(
          (body.credentials ?? {}) as Record<string, string>,
        ).sort();
      } else {
        expect(provider.provider).toBe("slack");
      }
      Object.assign(endpoint, {
        status: "verifying",
        providerAccountId: `account-${provider.provider}`,
        providerAccountLabel: provider.accountLabel,
        botExternalId: `bot-${provider.provider}`,
        botUsername: provider.botUsername,
        botLabel: provider.botLabel,
        setup: {
          ...endpoint.setup,
          step:
            provider.provider === "slack" && body.action === "configure"
              ? "provider_setup"
              : "test",
        },
      });
      await fulfill(route, endpoint);
      return;
    }

    if (
      pathname === `/api/chat-endpoints/${endpoint.id}/test` &&
      method === "POST"
    ) {
      Object.assign(endpoint, {
        status: "active",
        activatedAt: new Date().toISOString(),
        setup: { ...endpoint.setup, step: "complete" },
      });
      await fulfill(route, endpoint);
      return;
    }

    if (pathname === `/api/chat-endpoints/${endpoint.id}/resources`) {
      if (method === "GET") {
        await fulfill(route, { resources });
        return;
      }
      if (method === "PUT") {
        const updates = (bodyOf(route).resources ?? []) as Array<{
          id: string;
          enabled: boolean;
        }>;
        state.resourceUpdates.push(updates);
        for (const update of updates) {
          const target = resources.find((item) => item.id === update.id);
          if (target) target.enabled = update.enabled;
        }
        state.updatedResource = resource.enabled;
        await fulfill(route, resources);
        return;
      }
    }

    if (
      pathname === `/api/chat-endpoints/${endpoint.id}/principals` &&
      method === "GET"
    ) {
      await fulfill(route, {
        principals: [
          {
            id: `link-${provider.provider}`,
            principalId: `principal-${provider.provider}`,
            externalLabel: "Ada Lovelace",
            externalDetail: `ada@${provider.provider}`,
            paperclipUserId: null,
            paperclipUserLabel: null,
            status: "pending",
          },
          {
            id: `link-${provider.provider}-linked`,
            principalId: `principal-${provider.provider}-linked`,
            externalLabel: "Grace Hopper",
            externalDetail: `grace@${provider.provider}`,
            paperclipUserId:
              state.revokedPrincipalId ===
              `principal-${provider.provider}-linked`
                ? null
                : "paperclip-user-grace",
            paperclipUserLabel:
              state.revokedPrincipalId ===
              `principal-${provider.provider}-linked`
                ? null
                : "Grace Hopper",
            status:
              state.revokedPrincipalId ===
              `principal-${provider.provider}-linked`
                ? "revoked"
                : "linked",
          },
        ],
      });
      return;
    }

    if (
      pathname ===
        `/api/chat-endpoints/${endpoint.id}/principals/principal-${provider.provider}/link-intent` &&
      method === "POST"
    ) {
      state.linkIntentPrincipalId = `principal-${provider.provider}`;
      await fulfill(route, {
        confirmationUrl: `https://paperclip.example.test/${seed.prefix}/chat-identity/confirm?token=e2e-redacted`,
      });
      return;
    }

    if (
      pathname ===
        `/api/chat-endpoints/${endpoint.id}/principals/principal-${provider.provider}-linked/link` &&
      method === "DELETE"
    ) {
      state.revokedPrincipalId = `principal-${provider.provider}-linked`;
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (
      pathname === `/api/chat-endpoints/${endpoint.id}/conversations` &&
      method === "GET"
    ) {
      await fulfill(route, {
        conversations: [
          {
            id: `conversation-${provider.provider}`,
            companyId: seed.companyId,
            endpointId: endpoint.id,
            resourceId: resource.id,
            issueId: `issue-${provider.provider}`,
            issueIdentifier: "CHAT-123",
            issueTitle: `Investigate ${provider.name} delivery`,
            externalConversationId: `external-conversation-${provider.provider}`,
            externalThreadId: `external-thread-${provider.provider}`,
            externalLabel: provider.resourceLabel,
            externalUrl: provider.externalUrl,
            isDirectMessage: provider.provider === "telegram",
            state: "active",
            lastPublicationStatus: "published",
            createdAt: endpoint.createdAt,
            updatedAt: endpoint.updatedAt,
          },
        ],
      });
      return;
    }

    if (
      pathname === `/api/chat-endpoints/${endpoint.id}/activity` &&
      method === "GET"
    ) {
      await fulfill(route, {
        items: [
          {
            id: `delivery-${provider.provider}`,
            kind: "delivery",
            status: "failed",
            summary: `Inbound ${provider.name} delivery could not be processed`,
            detail: "Credential values and request bodies are redacted.",
            createdAt: endpoint.createdAt,
            replayable: true,
          },
          {
            id: `publication-${provider.provider}`,
            kind: "publication",
            status: "published",
            summary: `Published safe output to ${provider.name}`,
            createdAt: endpoint.createdAt,
            replayable: false,
          },
        ],
      });
      return;
    }

    if (
      pathname ===
        `/api/chat-endpoints/${endpoint.id}/deliveries/delivery-${provider.provider}/replay` &&
      method === "POST"
    ) {
      state.replayedDelivery = true;
      await fulfill(route, {});
      return;
    }

    await route.continue();
  });

  return state;
}

async function selectMaya(page: Page) {
  await page.getByRole("button", { name: "Choose an active agent" }).click();
  await page.getByRole("button", { name: "Select Maya" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

async function fillProviderSetup(page: Page, provider: ProviderCase) {
  if (provider.provider === "slack") {
    await page.getByLabel("Bot User OAuth Token").fill("xoxb-e2e-redacted");
    await page.getByLabel("Signing Secret").fill("slack-signing-secret");
  } else if (provider.provider === "github") {
    await page.getByRole("button", { name: "Generate webhook secret" }).click();
    await expect(page.getByLabel("Generated webhook secret")).toHaveValue(
      "github-webhook-secret",
    );
    await page.getByLabel("GitHub App ID").fill("123456");
    await page
      .getByLabel("Private key (PEM)")
      .fill(
        "-----BEGIN PRIVATE KEY-----\ne2e-redacted\n-----END PRIVATE KEY-----",
      );
  } else if (provider.provider === "microsoft-teams") {
    await page
      .getByLabel("Application / Client ID")
      .fill("00000000-0000-4000-8000-000000000001");
    await page
      .getByLabel("Directory / Tenant ID")
      .fill("00000000-0000-4000-8000-000000000002");
    await page.getByLabel("Client secret").fill("teams-client-secret");
  } else if (provider.provider === "discord") {
    await page.getByLabel("Application ID").fill("1457808928258658549");
    await page.getByLabel("Server ID").fill("1457808928258658549");
    await page.getByLabel("Bot token").fill("discord-e2e-redacted");
  } else {
    await page.getByLabel("Bot token").fill("123456:e2e-redacted");
  }
  await page.getByRole("button", { name: provider.setupButton }).click();
}

function expectedCredentialKeys(provider: Provider): string[] {
  if (provider === "slack") return ["botToken", "signingSecret"];
  if (provider === "github") return ["appId", "privateKey"];
  if (provider === "microsoft-teams")
    return ["clientId", "clientSecret", "tenantId"];
  if (provider === "discord") return ["applicationId", "botToken", "guildId"];
  return ["botToken"];
}

async function expectSetupRail(page: Page) {
  const rail = page.getByRole("list", { name: "Connection setup progress" });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("listitem")).toHaveCount(3);
  for (const label of ["Choose agent", "Connect provider", "Try it"]) {
    await expect(rail.getByText(label, { exact: true })).toBeVisible();
  }
}

function expectedSlackManifest(webhookUrl: string) {
  return `display_information:
  name: "maya-paperclip"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: "maya"
  slash_commands:
    - command: "/maya-public"
      description: Start or manage work with "Maya"
      usage_hint: "status | new | close | <task>"
      should_escape: false
      url: "${webhookUrl}"
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  event_subscriptions:
    request_url: "${webhookUrl}"
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - member_joined_channel
      - member_left_channel
      - channel_left
      - group_left
      - reaction_added
      - reaction_removed
      - channel_archive
      - group_archive
      - channel_unarchive
      - group_unarchive
      - channel_deleted
      - channel_rename
      - group_rename
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: "${webhookUrl}"`;
}

async function expectMinimumProviderSetup(page: Page, provider: ProviderCase) {
  const webhookUrl = `https://paperclip.example.test/api/chat-webhooks/public-${provider.provider}/${provider.provider}`;
  if (provider.provider === "slack") {
    await expect(page.getByText("From an app manifest")).toBeVisible();
    await expect(page.getByText("OAuth & Permissions")).toBeVisible();
    await expect(page.getByText("Basic Information")).toBeVisible();
    const manifest = await page.getByLabel("Slack app manifest").inputValue();
    expect(manifest).toBe(expectedSlackManifest(webhookUrl));
    await expect(page.getByLabel("Slack app manifest")).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(page.getByLabel("Bot User OAuth Token")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.getByLabel("Signing Secret")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(
      page.getByRole("button", { name: "Open Slack app settings" }),
    ).toBeVisible();
    return;
  }

  if (provider.provider === "github") {
    await expect(page.getByText(webhookUrl, { exact: true })).toBeVisible();
    await expect(page.getByText(/Metadata remains read-only/)).toBeVisible();
    await expect(page.getByText(/issue_comment/)).toBeVisible();
    await expect(page.getByText(/pull_request_review_comment/)).toBeVisible();
    await expect(page.getByText(/generate one private key/)).toBeVisible();
    await expect(page.getByText(/Enable SSL verification/)).toBeVisible();
    await expect(page.getByText(/Only on this account/)).toBeVisible();
    await expect(page.getByLabel("GitHub App ID")).toHaveAttribute(
      "type",
      "text",
    );
    await expect(
      page.getByRole("button", { name: "Generate webhook secret" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open new GitHub App form" }),
    ).toBeVisible();
    return;
  }

  if (provider.provider === "microsoft-teams") {
    const messagingEndpoint =
      "https://paperclip.example.test/api/chat-webhooks/public-microsoft-teams/microsoft-teams";
    await expect(
      page.getByText(messagingEndpoint, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/single-tenant app registration/),
    ).toBeVisible();
    await expect(
      page.getByText(/Microsoft 365 work or school organization/),
    ).toBeVisible();
    await expect(page.getByText(/teams\.live\.com/)).toBeVisible();
    await expect(
      page.getByText(/^In Azure, create an Azure Bot/),
    ).toBeVisible();
    await expect(page.getByText("Microsoft portal field map")).toBeVisible();
    await expect(
      page.getByText(/Accounts in this organizational directory only/),
    ).toBeVisible();
    await expect(page.getByText(/Use existing app registration/)).toBeVisible();
    await expect(
      page.getByText(/Configure · App features · Bot/),
    ).toBeVisible();
    await expect(
      page.getByText(/Upload an app · Upload a custom app/),
    ).toBeVisible();
    const manifest = await page
      .getByLabel("Required Teams app manifest block")
      .inputValue();
    expect(manifest).toContain("ChannelMessage.Read.Group");
    expect(manifest).toContain("ChatMessage.Read.Chat");
    expect(manifest).toContain('"personal"');
    expect(manifest).toContain('"team"');
    expect(manifest).toContain('"groupchat"');
    expect(manifest).not.toContain("webApplicationInfo");
    expect(manifest).not.toContain("api://paperclip-chat/");
    await expect(
      page.getByRole("button", { name: "Copy manifest settings" }),
    ).toBeDisabled();
    await expect(page.getByText(/not a complete app package/)).toBeVisible();
    await expect(
      page.getByText(/does not use Teams single sign-on/),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Microsoft Entra" }),
    ).toHaveAttribute("href", /entra\.microsoft\.com/);
    await expect(
      page.getByRole("link", { name: "Create Azure Bot" }),
    ).toHaveAttribute("href", /portal\.azure\.com/);
    await expect(
      page.getByRole("link", { name: "Open Teams Developer Portal" }),
    ).toHaveAttribute("href", /dev\.teams\.microsoft\.com/);
    await expect(page.getByLabel("Application / Client ID")).toHaveAttribute(
      "type",
      "text",
    );
    await expect(page.getByLabel("Directory / Tenant ID")).toHaveAttribute(
      "type",
      "text",
    );
    await expect(page.getByLabel("Client secret value")).toHaveAttribute(
      "type",
      "password",
    );
    return;
  }

  if (provider.provider === "discord") {
    await expect(page.getByText(/enable Message Content Intent/)).toBeVisible();
    await expect(page.getByText(/copy its Server ID/)).toBeVisible();
    await expect(page.getByLabel("Application ID")).toHaveAttribute(
      "type",
      "text",
    );
    await expect(page.getByLabel("Server ID")).toHaveAttribute("type", "text");
    await expect(page.getByLabel("Bot token")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(
      page.getByRole("button", { name: "Open Discord Developer Portal" }),
    ).toBeVisible();
    await page.getByLabel("Application ID").fill("1457808928258658549");
    await page.getByLabel("Server ID").fill("1457808928258658549");
    await expect(
      page.getByRole("link", { name: "Install bot in this server" }),
    ).toHaveAttribute(
      "href",
      /client_id=1457808928258658549&permissions=309237763136&scope=bot&guild_id=1457808928258658549&disable_guild_select=true/,
    );
    await expect(page.getByText(/Create Public Threads/)).toBeVisible();
    return;
  }

  await expect(page.getByText("/newbot", { exact: true })).toBeVisible();
  await expect(page.getByText(/username ending in/)).toBeVisible();
  await expect(page.getByText(/\/task@bot_username/)).toBeVisible();
  await expect(
    page.getByText(/ordinary mentions are not delivered/),
  ).toBeVisible();
  await expect(page.getByLabel("Bot token")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(
    page.getByRole("button", { name: "Open BotFather" }),
  ).toBeVisible();
}

async function expectProviderTryInstructions(
  page: Page,
  provider: ProviderCase,
) {
  const expected =
    provider.provider === "slack"
      ? [
          "Open a channel and invite the bot if needed.",
          "Mention @maya-paperclip in a new channel message.",
          "Reply once in Maya's thread.",
        ]
      : provider.provider === "github"
        ? [
            "Open an installed issue or pull request.",
            "Mention @maya-paperclip in a comment.",
            "Add another comment to continue the same task.",
          ]
        : provider.provider === "microsoft-teams"
          ? [
              "Open an installed channel and start a new post.",
              "Mention @maya-paperclip in the post.",
              "Reply once beneath the post.",
            ]
          : provider.provider === "discord"
            ? [
                "Open a text channel where the bot is installed.",
                "Mention @maya-paperclip in a new root message.",
                "Reply once inside Maya's new Discord thread.",
              ]
            : [
                "Open the bot's private chat.",
                "Tap Start.",
                "Send “Help me test this”.",
              ];
  for (const instruction of expected) {
    await expect(page.getByText(instruction, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: `Open ${provider.name}` }),
  ).toBeVisible();
}

test.describe.serial("native chat adapter UI", () => {
  test.setTimeout(180_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });

  for (const provider of PROVIDERS) {
    test(`${provider.name}: catalog, setup, and connection management tabs`, async ({
      page,
    }) => {
      const mock = await installChatControlPlaneMock(page, provider, seed);

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
      expect(mock.createdWithAgentId).toBe(seed.agentId);
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
        {
          id: `resource-${provider.provider}-secondary`,
          enabled: false,
        },
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
      await expect(page.getByText("xoxb-e2e-redacted")).toHaveCount(0);
      await expect(page.getByText("teams-client-secret")).toHaveCount(0);
      await expect(page.getByText("github-webhook-secret")).toHaveCount(0);
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
      await expect(
        page.getByRole("heading", { name: provider.setupHeading }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Choose an active agent" }),
      ).toHaveCount(0);

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
