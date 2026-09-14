import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
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

type Provider = "slack" | "github" | "discord" | "microsoft-teams" | "telegram" | "imessage-photon";

const GITHUB_PRIVATE_KEY_FIXTURE =
  "-----BEGIN PRIVATE KEY-----\nlocal-e2e-key\n-----END PRIVATE KEY-----\n";
const GITHUB_PRIVATE_KEY_PASTE_FIXTURE =
  "-----BEGIN PRIVATE KEY-----\nlocal-e2e-pasted-key\n-----END PRIVATE KEY-----\n";

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
  "imessage-photon": { reconnect: "Reconnect the same dedicated Photon number", remove: "does not delete the Photon project" },
  slack: {
    reconnect:
      "Reconnect verifies or replaces credentials for this same Slack app. It does not reinstall the app or change its workspace or channel membership.",
    remove: "It does not uninstall the Slack app",
  },
  github: {
    reconnect:
      "Reconnect verifies this same App and installation, then updates its webhook URL, secret, and secure delivery settings. It does not reinstall the App or change repository access.",
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
  chatEndpointListReads: number;
  createdWithAgentId: string | null;
  configuredCredentialKeys: string[];
  githubPrivateKeyMatchedFile: boolean | null;
  githubPrivateKeyMatchedPaste: boolean | null;
  githubSetupSecretRequests: number;
  setupAttempts: number;
  updatedResource: boolean;
  resourceUpdates: Array<Array<{ id: string; enabled: boolean }>>;
  allowDirectMessages: boolean | null;
  allowGroupChats: boolean | null;
  allowUnlinkedPeople: boolean | null;
  linkIntentPrincipalId: string | null;
  revokedPrincipalId: string | null;
  lifecycleActions: string[];
  replayedDelivery: boolean;
  liveActivitySummary: string | null;
  conversationState: "active" | "waiting";
  removed: boolean;
  setStatus: (status: string) => void;
  setGitHubWebhookVerified: () => void;
};

async function installChatControlPlaneMock(
  page: Page | BrowserContext,
  provider: ProviderCase,
  seed: Seed,
  {
    enableChatConnectors,
    resourceCount = 2,
    photonShared = false,
  }: { enableChatConnectors: boolean; resourceCount?: number; photonShared?: boolean },
): Promise<ChatMock> {
  const endpoint = endpointFixture(provider, seed);
  const state: ChatMock & {
    created: boolean;
    failNextGitHubEndpointRead: boolean;
  } = {
    created: false,
    failNextGitHubEndpointRead: false,
    chatEndpointListReads: 0,
    createdWithAgentId: null,
    configuredCredentialKeys: [],
    githubPrivateKeyMatchedFile: null,
    githubPrivateKeyMatchedPaste: null,
    githubSetupSecretRequests: 0,
    setupAttempts: 0,
    updatedResource: false,
    resourceUpdates: [],
    allowDirectMessages: null,
    allowGroupChats: null,
    allowUnlinkedPeople: null,
    linkIntentPrincipalId: null,
    revokedPrincipalId: null,
    lifecycleActions: [],
    replayedDelivery: false,
    liveActivitySummary: null,
    conversationState: "active",
    removed: false,
    setStatus: (status) => {
      endpoint.status = status;
    },
    setGitHubWebhookVerified: () => {
      endpoint.setup.webhookVerifiedAt = new Date().toISOString();
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
  const resources = [
    resource,
    secondaryResource,
    ...Array.from({ length: Math.max(0, resourceCount - 2) }, (_, index) => ({
      ...resource,
      id: `resource-${provider.provider}-extra-${index}`,
      providerResourceId: `provider-resource-${provider.provider}-extra-${index}`,
      label: `Extra destination ${index + 1}`,
    })),
  ];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (pathname === `/api/companies/${seed.companyId}/chat-endpoints`) {
      if (method === "GET") {
        state.chatEndpointListReads += 1;
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
        if (
          provider.provider === "github" &&
          state.failNextGitHubEndpointRead
        ) {
          state.failNextGitHubEndpointRead = false;
          await fulfill(route, { error: "Temporary read failure." }, 503);
          return;
        }
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
      pathname === "/api/instance/settings/experimental" &&
      method === "GET"
    ) {
      await fulfill(route, {
        enableChatConnectors,
        enableIsolatedWorkspaces: false,
      });
      return;
    }

    if (
      pathname === `/api/chat-endpoints/${endpoint.id}/setup-secret` &&
      method === "POST"
    ) {
      state.githubSetupSecretRequests += 1;
      endpoint.setup.webhookSecretConfigured = true;
      endpoint.setup.step = "provider_setup";
      endpoint.setup.webhookVerifiedAt =
        state.githubSetupSecretRequests === 1 ? new Date().toISOString() : null;
      if (state.githubSetupSecretRequests > 1) {
        state.failNextGitHubEndpointRead = true;
      }
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
        state.setupAttempts += 1;
        state.configuredCredentialKeys = Object.keys(
          (body.credentials ?? {}) as Record<string, string>,
        ).sort();
        if (provider.provider === "github") {
          const privateKey = (
            (body.credentials ?? {}) as Record<string, string>
          ).privateKey;
          state.githubPrivateKeyMatchedFile =
            state.githubPrivateKeyMatchedFile === true ||
            privateKey === GITHUB_PRIVATE_KEY_FIXTURE;
          state.githubPrivateKeyMatchedPaste =
            state.githubPrivateKeyMatchedPaste === true ||
            privateKey === GITHUB_PRIVATE_KEY_PASTE_FIXTURE;
          if (state.setupAttempts === 1) {
            await fulfill(
              route,
              { error: "GitHub rejected the supplied App credentials." },
              422,
            );
            return;
          }
        }
        if (provider.provider === "telegram" && state.setupAttempts === 1) {
          const submittedToken = String(
            ((body.credentials ?? {}) as Record<string, string>).botToken ?? "",
          );
          await fulfill(
            route,
            {
              error: `Telegram rejected bot token ${submittedToken}. Confirm the token in BotFather and try again.`,
            },
            422,
          );
          return;
        }
      } else {
        expect(provider.provider).toBe("slack");
      }
      if (provider.provider === "imessage-photon") {
        expect(body.photon).toEqual(photonShared ? {allocation:"shared",projectId:"project-e2e"} : {allocation:"dedicated",projectId:"project-e2e",lineId:"line-one"});
      }
      Object.assign(endpoint, {
        ...(provider.provider === "imessage-photon" ? {photonAllocation: photonShared ? "shared" : "dedicated", allowGroupChats: !photonShared} : {}),
        status: "verifying",
        providerAccountId: `account-${provider.provider}`,
        providerAccountLabel: provider.accountLabel,
        botExternalId: provider.provider === "imessage-photon" ? photonShared ? "photon-project:project-e2e" : "+15555550100" : `bot-${provider.provider}`,
        botUsername: photonShared ? null : provider.botUsername,
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

    if (pathname === `/api/chat-endpoints/${endpoint.id}/photon/inspect` && method === "POST") {
      expect(bodyOf(route)).toEqual({projectId:"project-e2e",projectSecret:"photon-test-secret"});
      await fulfill(route,{projectId:"project-e2e",projectName:"Photon Test",allocation:photonShared ? "shared" : "dedicated",eligible:true,lines:photonShared ? [] : [{lineId:"line-one",phoneNumber:"+15555550100",eligible:true},{lineId:"line-two",phoneNumber:"+15555550102",eligible:true}]}); return;
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
        // Match the real request-size boundary without contacting a provider.
        if (updates.length > 500) {
          await fulfill(route, { error: "Too many resource updates." }, 400);
          return;
        }
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
            externalUrl: provider.provider === "imessage-photon" ? null : provider.externalUrl,
            isDirectMessage: provider.provider === "telegram",
            state: state.conversationState,
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
          ...(state.liveActivitySummary
            ? [
                {
                  id: `live-reaction-${provider.provider}`,
                  kind: "delivery",
                  status: "processed",
                  summary: state.liveActivitySummary,
                  createdAt: endpoint.createdAt,
                  replayable: false,
                },
              ]
            : []),
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
    const privateKeyFile = page.getByLabel(
      "Choose GitHub App private key file",
    );
    await privateKeyFile.setInputFiles({
      name: "paperclip-test.pem",
      mimeType: "application/x-pem-file",
      buffer: Buffer.alloc(64 * 1024 + 1, "x"),
    });
    await expect(page.getByRole("alert")).toContainText(
      "That file is too large. Choose a GitHub App private key smaller than 64 KB.",
    );
    await page.getByLabel("GitHub App ID").focus();
    await page.getByLabel("GitHub App ID").press("Tab");
    await expect(page.getByRole("alert")).toBeVisible();
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose .pem file" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "paperclip-test.pem",
      mimeType: "application/x-pem-file",
      buffer: Buffer.from(GITHUB_PRIVATE_KEY_FIXTURE),
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      "Private key loaded. It stays in this form until you connect.",
    );
    await expect(
      page.getByRole("button", { name: "Show private key" }),
    ).toBeVisible();
    await expect(page.getByLabel("Private key (PEM)")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.locator("textarea#github-private-key")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(
      GITHUB_PRIVATE_KEY_FIXTURE,
    );
    await expect(page.locator("body")).not.toContainText("paperclip-test.pem");
    await page.getByRole("button", { name: provider.setupButton }).click();
    await expect(page.getByRole("alert")).toContainText("Connection failed");
    await page
      .getByLabel("Private key (PEM)")
      .evaluate((element, privateKey) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", privateKey);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      }, GITHUB_PRIVATE_KEY_PASTE_FIXTURE);
    await expect(page.locator("textarea#github-private-key")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(
      GITHUB_PRIVATE_KEY_PASTE_FIXTURE,
    );
    await page.getByRole("button", { name: "Show private key" }).click();
    await expect(page.locator("textarea#github-private-key")).toHaveValue(
      GITHUB_PRIVATE_KEY_PASTE_FIXTURE,
    );
    await page.getByRole("button", { name: "Hide private key" }).click();
    await expect(page.locator("textarea#github-private-key")).toHaveCount(0);
    await expect(page.getByLabel("Private key (PEM)")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.locator("body")).not.toContainText(
      GITHUB_PRIVATE_KEY_PASTE_FIXTURE,
    );
  } else if (provider.provider === "microsoft-teams") {
    const clientId = "00000000-0000-4000-8000-000000000001";
    await page.getByLabel("Application / Client ID").fill(clientId);
    await page
      .getByLabel("Directory / Tenant ID")
      .fill("00000000-0000-4000-8000-000000000002");
    await page.getByLabel("Client secret").fill("teams-client-secret");
    const manifest = JSON.parse(
      await page.getByLabel("Required Teams app manifest block").inputValue(),
    ) as { webApplicationInfo?: { id?: string; resource?: string } };
    expect(manifest.webApplicationInfo).toEqual({
      id: clientId,
      resource: "https://paperclip.ing",
    });
    await expect(
      page.getByRole("button", { name: "Copy manifest settings" }),
    ).toBeEnabled();
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
  agent_view:
    agent_description: "Work with a Paperclip agent in a task-backed conversation."
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
      - assistant:write
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
      - agent_session_stopped
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
    expect(manifest).toContain('"groupChat"');
    expect(JSON.parse(manifest)).toMatchObject({
      bots: [
        {
          commandLists: [
            {
              scopes: ["personal", "groupChat"],
              commands: [
                { title: "/status" },
                { title: "/new" },
                { title: "/close" },
              ],
            },
          ],
        },
      ],
      webApplicationInfo: {
        id: "<application-client-id>",
        resource: "https://paperclip.ing",
      },
    });
    expect(manifest).not.toContain("api://paperclip-chat/");
    expect(manifest).not.toContain("supportsTargetedMessages");
    await expect(
      page.getByRole("button", { name: "Copy manifest settings" }),
    ).toBeDisabled();
    await expect(page.getByText(/not a complete app package/)).toBeVisible();
    await expect(
      page.getByText(/does not use Teams single sign-on/),
    ).toBeVisible();
    await expect(
      page.getByText(/only associates the RSC permissions/),
    ).toBeVisible();
    await expect(page.getByText(/receive every message/).first()).toBeVisible();
    await expect(
      page.getByText(/One team install covers its standard channels/),
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
    page.getByRole("link", { name: `Open ${provider.name}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Open ${provider.name}` }),
  ).toHaveAttribute("href", provider.externalUrl);
}

test.describe("chat destination partial updates", () => {
  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
  });

  for (const initiallyEnabled of [false, true]) {
    test(`a stale Settings view preserves another view's ${initiallyEnabled ? "revocation" : "grant"}`, async ({
      context,
      page,
    }) => {
      const provider = PROVIDERS.find((item) => item.provider === "discord")!;
      // Both real pages share one server fixture, but have separate query caches.
      const mock = await installChatControlPlaneMock(context, provider, seed, {
        enableChatConnectors: true,
      });
      mock.setStatus("active");
      const settingsUrl = `/${seed.prefix}/apps/chat/endpoint-discord/settings`;
      const primarySwitch = (view: Page) =>
        view.getByRole("switch", { name: `Enable ${provider.resourceLabel}` });
      const secondarySwitch = (view: Page) =>
        view.getByRole("switch", {
          name: `Enable ${provider.secondaryResourceLabel}`,
        });

      await page.goto(settingsUrl);
      await expect(primarySwitch(page)).not.toBeChecked();
      if (initiallyEnabled) {
        await primarySwitch(page).click();
        await expect(primarySwitch(page)).toBeChecked();
      }
      const staleView = await context.newPage();
      await staleView.goto(settingsUrl);
      await expect(primarySwitch(staleView)).toBeChecked({
        checked: initiallyEnabled,
      });
      await expect(secondarySwitch(staleView)).not.toBeChecked();

      await primarySwitch(page).click();
      await expect(primarySwitch(page)).toBeChecked({
        checked: !initiallyEnabled,
      });
      // Assert the stale prerequisite instead of assuming browser focus/refetch.
      await expect(primarySwitch(staleView)).toBeChecked({
        checked: initiallyEnabled,
      });
      await secondarySwitch(staleView).click();
      await expect(secondarySwitch(staleView)).toBeChecked();
      await expect(primarySwitch(staleView)).toBeChecked({
        checked: !initiallyEnabled,
      });
      expect(mock.resourceUpdates.at(-1)).toEqual([
        { id: "resource-discord-secondary", enabled: true },
      ]);

      // The full response refreshes this page, and persisted state survives reload.
      await page.reload();
      await expect(primarySwitch(page)).toBeChecked({
        checked: !initiallyEnabled,
      });
      await expect(secondarySwitch(page)).toBeChecked();
      await staleView.close();
    });
  }

  test("a pending destination change stays truthful on rejection and explicit retry", async ({
    page,
  }, testInfo) => {
    const provider = PROVIDERS.find((item) => item.provider === "discord")!;
    const mock = await installChatControlPlaneMock(page, provider, seed, {
      enableChatConnectors: true,
    });
    mock.setStatus("active");
    const attempts: unknown[] = [];
    let holdFirstPut!: (route: Route) => void;
    const firstPut = new Promise<Route>((resolve) => {
      holdFirstPut = resolve;
    });
    await page.route(
      "**/api/chat-endpoints/endpoint-discord/resources",
      async (route) => {
        if (route.request().method() === "PUT") {
          attempts.push(bodyOf(route));
          if (attempts.length === 1) {
            holdFirstPut(route);
            return;
          }
        }
        await route.fallback();
      },
    );
    await page.goto(`/${seed.prefix}/apps/chat/endpoint-discord/settings`);
    const primary = page.getByRole("switch", { name: "Enable #general" });
    const secondary = page.getByRole("switch", { name: "Enable #support" });
    await expect(primary).not.toBeChecked();
    await primary.click();
    const held = await firstPut;
    try {
      await expect(primary).toBeDisabled();
      await expect(secondary).toBeDisabled();
      await expect(primary).not.toBeChecked();
      await expect(secondary).not.toBeChecked();
      expect(mock.resourceUpdates).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath("destination-pending.png"),
      });
    } finally {
      await fulfill(
        held,
        { error: "Destination is no longer available. Refresh and try again." },
        409,
      );
    }
    await expect(
      page.getByText("Couldn't update destination", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Destination is no longer available. Refresh and try again.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(primary).toBeEnabled();
    await expect(secondary).toBeEnabled();
    await expect(primary).not.toBeChecked();
    await expect(secondary).not.toBeChecked();
    expect(mock.resourceUpdates).toEqual([]);
    expect(attempts).toEqual([
      { resources: [{ id: "resource-discord", enabled: true }] },
    ]);
    // Visibility alone also matches the toast's initial transparent animation frame.
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "Couldn't update destination" }),
    ).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: testInfo.outputPath("destination-rejected.png"),
    });
    await primary.click();
    await expect(primary).toBeChecked();
    await expect(secondary).not.toBeChecked();
    expect(attempts).toEqual([
      { resources: [{ id: "resource-discord", enabled: true }] },
      { resources: [{ id: "resource-discord", enabled: true }] },
    ]);
    expect(mock.resourceUpdates).toEqual([
      [{ id: "resource-discord", enabled: true }],
    ]);
    await page.reload();
    await expect(primary).toBeChecked();
    await expect(secondary).not.toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath("destination-retry-saved.png"),
    });
  });

  test("one toggle succeeds with more than 500 discovered destinations", async ({
    page,
  }) => {
    const provider = PROVIDERS.find((item) => item.provider === "discord")!;
    const mock = await installChatControlPlaneMock(page, provider, seed, {
      enableChatConnectors: true,
      resourceCount: 501,
    });
    mock.setStatus("active");
    await page.goto(`/${seed.prefix}/apps/chat/endpoint-discord/settings`);
    await expect(page.getByRole("switch", { name: /^Enable / })).toHaveCount(
      501,
    );
    const target = page.getByRole("switch", {
      name: "Enable Extra destination 499",
    });
    await expect(target).not.toBeChecked();
    await target.click();
    await expect(target).toBeChecked();
    expect(mock.resourceUpdates).toEqual([
      [{ id: "resource-discord-extra-498", enabled: true }],
    ]);
    await expect(
      page.getByRole("switch", { name: "Enable #general" }),
    ).not.toBeChecked();
    await page.reload();
    await expect(target).toBeChecked();
    await expect(page.getByRole("switch", { name: /^Enable / })).toHaveCount(
      501,
    );
  });
});

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
        expect(mock.githubPrivateKeyMatchedFile).toBe(true);
        expect(mock.githubPrivateKeyMatchedPaste).toBe(true);
        expect(mock.setupAttempts).toBe(2);
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

test.describe("Board send delivery refresh", () => {
  for (const classic of [false, true]) {
    for (const entry of [
      "uuid",
      "uppercase-uuid",
      "wrong-prefix-identifier",
    ] as const) {
      test(`opens external task links in their own organization and uploads safely (${entry}, classic=${classic})`, async ({
        page,
        request,
      }) => {
        const selected = await seedCompanyAndAgent(request);
        const target = await seedCompanyAndAgent(request);
        const issue = await json<{ id: string; identifier: string }>(
          await request.post(`/api/companies/${target.companyId}/issues`, {
            data: { title: "Organization-bound task link", status: "backlog" },
          }),
          "create linked task in another organization",
        );
        await page.route("**/api/instance/settings/experimental", (route) =>
          fulfill(route, {
            enableChatConnectors: true,
            enableClassicTaskInterface: classic,
          }),
        );
        await page.goto(`/${selected.prefix}/issues`);
        await expect
          .poll(() =>
            page.evaluate(() =>
              localStorage.getItem("paperclip.selectedCompanyId"),
            ),
          )
          .toBe(selected.companyId);
        await page.goto(
          entry === "uuid"
            ? `/issues/${issue.id}`
            : entry === "uppercase-uuid"
              ? `/issues/${issue.id.toUpperCase()}`
              : `/${selected.prefix}/issues/${issue.identifier}?external=chat#files`,
        );
        await expect(
          page.getByRole("heading", {
            name: "Organization-bound task link",
            exact: true,
          }),
        ).toBeVisible();
        await expect
          .soft(page)
          .toHaveURL(
            new RegExp(
              `/${target.prefix}/issues/${issue.identifier}${
                entry === "wrong-prefix-identifier"
                  ? "\\?external=chat#files"
                  : ""
              }$`,
            ),
            { timeout: 4_000 },
          );
        const file = {
          name: classic ? "task-link-report.txt" : "task-link-image.png",
          mimeType: classic ? "text/plain" : "image/png",
          buffer: classic
            ? Buffer.from("Synthetic cross-organization upload proof.\n")
            : Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfFoAAAAASUVORK5CYII=",
                "base64",
              ),
        };
        const chooserPromise = page.waitForEvent("filechooser");
        await page
          .getByRole("button", {
            name: classic ? "Upload attachment" : "Attach file",
            exact: true,
          })
          .click();
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            /\/api\/companies\/[^/]+\/issues\/[^/]+\/attachments$/.test(
              new URL(response.url()).pathname,
            ),
        );
        await (await chooserPromise).setFiles(file);
        const response = await responsePromise;
        expect.soft(response.status(), await response.text()).toBe(201);
        expect
          .soft(new URL(response.url()).pathname)
          .toBe(
            `/api/companies/${target.companyId}/issues/${issue.id}/attachments`,
          );
        const attachments = await json<
          {
            originalFilename: string;
            contentPath: string;
            issueCommentId: string | null;
          }[]
        >(
          await request.get(`/api/issues/${issue.id}/attachments`),
          "read linked task attachments",
        );
        expect(attachments).toHaveLength(1);
        expect(attachments[0]).toMatchObject({
          originalFilename: file.name,
          issueCommentId: null,
        });
        expect(
          await (await request.get(attachments[0].contentPath)).body(),
        ).toEqual(file.buffer);
        expect(
          await json<unknown[]>(
            await request.get(`/api/issues/${issue.id}/comments`),
            "read linked task comments",
          ),
        ).toHaveLength(0);
        await expect
          .poll(() =>
            page.evaluate(() =>
              localStorage.getItem("paperclip.selectedCompanyId"),
            ),
          )
          .toBe(target.companyId);
      });
    }
  }

  test("keeps the connected-task banner readable in narrow task panes", async ({
    page,
    request,
  }) => {
    const seed = await seedCompanyAndAgent(request);
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Connected banner layout", status: "backlog" },
      }),
      "create connected banner task",
    );
    await page.route("**/api/instance/settings/experimental", (route) =>
      fulfill(route, { enableChatConnectors: true }),
    );
    await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
      fulfill(route, {
        endpointId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        provider: "discord",
        externalLabel: "#a-long-but-readable-qualification-channel-name",
        externalUrl: "https://discord.com/channels/test-server/test-thread",
        assignedAgentLocked: true,
      }),
    );
    await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
    const banner = page.getByRole("region", {
      name: "External conversation",
      exact: true,
    });
    const heading = banner.getByText("Connected to Discord", { exact: true });
    await expect(heading).toBeVisible();
    // Exercise container widths independently of the operator's sidebar and
    // Properties preferences. These are test constraints, not product styles.
    for (const width of [340, 500, 760]) {
      await banner.evaluate((element, value) => {
        element.style.width = `${value}px`;
      }, width);
      await expect
        .poll(() =>
          heading
            .evaluate((element) => ({
              height: element.getBoundingClientRect().height,
              lineHeight: Number.parseFloat(
                getComputedStyle(element).lineHeight,
              ),
            }))
            .then(({ height, lineHeight }) => height <= lineHeight * 1.5),
        )
        .toBe(true);
      const bounds = await banner.boundingBox();
      expect(bounds).not.toBeNull();
      for (const action of [
        banner.getByRole("link", { name: "Open Discord", exact: true }),
        banner.getByRole("button", { name: "Send to channel", exact: true }),
        banner.getByRole("link", { name: "Connection", exact: true }),
      ]) {
        await expect(action).toBeVisible();
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          bounds!.x + bounds!.width,
        );
        expect(box!.y + box!.height).toBeLessThanOrEqual(
          bounds!.y + bounds!.height,
        );
      }
    }
  });

  test("uploads images and files directly from an empty channel composer without publishing early", async ({
    page,
    request,
  }) => {
    const seed = await seedCompanyAndAgent(request);
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Upload channel files", status: "backlog" },
      }),
      "create upload task",
    );
    const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const publicationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const sends: Record<string, unknown>[] = [];
    let releaseSend!: () => void;
    const sendResponse = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    await page.route("**/api/instance/settings/experimental", (route) =>
      fulfill(route, { enableChatConnectors: true }),
    );
    await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
      fulfill(route, {
        endpointId,
        conversationId,
        provider: "discord",
        externalLabel: "#upload-test",
        assignedAgentLocked: true,
      }),
    );
    await page.route(
      `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
      async (route) => {
        sends.push(bodyOf(route));
        await sendResponse;
        return fulfill(
          route,
          { id: publicationId, state: "streaming", attempts: 1 },
          201,
        );
      },
    );
    await page.route(
      `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications/${publicationId}/status`,
      (route) =>
        fulfill(route, {
          publication: { id: publicationId, state: "pending", attempts: 0 },
          total: 3,
          published: 0,
        }),
    );
    await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
    await page
      .getByRole("button", { name: "Send to channel", exact: true })
      .click();
    const input = page.getByLabel("Attach file to channel update", {
      exact: true,
    });
    const files = [
      {
        name: "channel-image.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfFoAAAAASUVORK5CYII=",
          "base64",
        ),
      },
      {
        name: "channel-report.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic channel upload proof.\n"),
      },
    ];
    for (const file of files) {
      await input.setInputFiles(file);
      await expect(
        page
          .getByRole("group", { name: "Include task files", exact: true })
          .getByRole("checkbox", { name: file.name, exact: true }),
      ).toBeChecked();
      await expect(input).toBeEnabled();
    }
    expect(sends).toHaveLength(0);
    const stored = await json<
      {
        id: string;
        originalFilename: string;
        contentPath: string;
        issueCommentId: string | null;
      }[]
    >(
      await request.get(`/api/issues/${issue.id}/attachments`),
      "read uploaded files",
    );
    expect(stored).toHaveLength(2);
    for (const file of files) {
      const attachment = stored.find(
        (item) => item.originalFilename === file.name,
      )!;
      expect(attachment.issueCommentId).toBeNull();
      const content = await request.get(attachment.contentPath);
      expect(content.ok()).toBe(true);
      expect(await content.body()).toEqual(file.buffer);
    }
    expect(
      await json<unknown[]>(
        await request.get(`/api/issues/${issue.id}/comments`),
        "read internal comments",
      ),
    ).toHaveLength(0);
    await page
      .getByRole("textbox", { name: "Board update", exact: true })
      .fill("Publish these two synthetic files.");
    await page
      .getByRole("button", { name: "Send to channel", exact: true })
      .last()
      .click();
    await expect.poll(() => sends.length).toBe(1);
    await expect(
      page.getByRole("button", { name: "Sending…", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Delivery result not confirmed", { exact: true }),
    ).toHaveCount(0);
    releaseSend();
    expect(sends[0].attachmentIds).toEqual(
      files.map(
        (file) =>
          stored.find((item) => item.originalFilename === file.name)!.id,
      ),
    );
    await expect(input).toBeDisabled();
    await page.reload();
    const retained = page.getByRole("group", {
      name: "Files in this send",
      exact: true,
    });
    for (const file of files) {
      await expect(
        retained.getByRole("checkbox", { name: file.name, exact: true }),
      ).toBeChecked();
      await expect(
        retained.getByRole("checkbox", { name: file.name, exact: true }),
      ).toBeDisabled();
    }
    expect(sends).toHaveLength(1);
  });

  test("recovers an uncertain channel send into a durable rejection before an explicit correction", async ({
    page,
    request,
  }, testInfo) => {
    const seed = await seedCompanyAndAgent(request);
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Rejected channel selection", status: "backlog" },
      }),
      "create rejected-send task",
    );
    const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await page.route("**/api/instance/settings/experimental", (route) =>
      fulfill(route, { enableChatConnectors: true }),
    );
    await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
      fulfill(route, {
        endpointId,
        conversationId,
        provider: "github",
        externalLabel: "test/rejected-send",
        assignedAgentLocked: true,
      }),
    );
    const sends: Record<string, unknown>[] = [];
    let attachmentId = "";
    await page.route(
      `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
      async (route) => {
        const input = bodyOf(route);
        sends.push(input);
        if (sends.length === 1) return route.abort("connectionreset");
        if (sends.length === 2)
          return fulfill(
            route,
            {
              error: "A selected file already belongs to another comment",
              details: {
                code: "chat_board_send_attachments_already_bound",
                endpointId,
                conversationId,
                idempotencyKey: input.idempotencyKey,
                attachmentIds: [attachmentId],
              },
            },
            409,
          );
        return fulfill(
          route,
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            state: "published",
            attempts: 1,
          },
          201,
        );
      },
    );
    await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
    const banner = page.getByRole("region", { name: "External conversation" });
    await banner
      .getByRole("button", { name: "Send to channel", exact: true })
      .click();
    await banner
      .getByLabel("Attach file to channel update", { exact: true })
      .setInputFiles({
        name: "rejected-send.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic rejected send proof.\n"),
      });
    await expect(
      banner.getByRole("checkbox", { name: "rejected-send.txt" }),
    ).toBeChecked();
    const [file] = await json<{ id: string }[]>(
      await request.get(`/api/issues/${issue.id}/attachments`),
      "read selected file",
    );
    attachmentId = file!.id;
    // A concurrent ordinary Board comment consumes the file. The browser
    // fixture emulates the precise durable rejection; real TX/idempotency
    // and delete/retry behavior are covered in the PostgreSQL integration test.
    const privateComment = await json<{ id: string }>(
      await request.post(`/api/issues/${issue.id}/comments`, {
        data: { body: "Private Board file", attachmentIds: [attachmentId] },
      }),
      "bind selected file to private comment",
    );
    const draft =
      "Share the verified result, without the private Board comment.";
    await banner.getByRole("textbox", { name: "Board update" }).fill(draft);
    await banner
      .getByRole("button", { name: "Send to channel", exact: true })
      .last()
      .click();
    await expect(
      banner.getByText("Delivery result not confirmed", { exact: true }),
    ).toBeVisible();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toBeDisabled();
    await banner
      .getByRole("button", { name: "Retry safely", exact: true })
      .click();
    await expect(
      banner.getByText("Update was not sent", { exact: true }),
    ).toBeVisible();
    expect(sends[1]).toEqual(sends[0]);
    await page.reload();
    await expect(
      banner.getByText("Update was not sent", { exact: true }),
    ).toBeVisible();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toHaveValue(draft);
    expect(sends).toHaveLength(2);
    await banner.screenshot({
      path: testInfo.outputPath("durable-rejected-channel-send.png"),
    });
    await banner
      .getByRole("button", { name: "Edit rejected send", exact: true })
      .click();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toBeEnabled();
    await expect(
      banner.getByText(/Attach a new copy or share the task link/),
    ).toBeVisible();
    await expect(banner.getByRole("checkbox")).toHaveCount(0);
    await banner
      .getByRole("button", { name: "Send to channel", exact: true })
      .last()
      .click();
    await expect(
      banner.getByRole("textbox", { name: "Board update" }),
    ).toHaveCount(0);
    expect(sends).toHaveLength(3);
    expect(sends[2]!.body).toBe(draft);
    expect(sends[2]!.attachmentIds ?? []).toEqual([]);
    expect(sends[2]!.idempotencyKey).not.toBe(sends[0]!.idempotencyKey);
    const attachments = await json<{ id: string; issueCommentId: string }[]>(
      await request.get(`/api/issues/${issue.id}/attachments`),
      "verify immutable original binding",
    );
    expect(attachments).toEqual([
      expect.objectContaining({
        id: attachmentId,
        issueCommentId: privateComment.id,
      }),
    ]);
  });

  for (const cancelledHead of [false, true]) {
    test(`keeps Teams file consent anchored across reload (${cancelledHead ? "cancelled head with waiting tail" : "mixed terminal receipt and explicit dismiss"})`, async ({
      page,
      request,
    }, testInfo) => {
      const seed = await seedCompanyAndAgent(request);
      const issue = await json<{ id: string; identifier: string }>(
        await request.post(`/api/companies/${seed.companyId}/issues`, {
          data: { title: "Teams consent receipt", status: "backlog" },
        }),
        "create consent receipt task",
      );
      const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const anchor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const nextAnchor = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const filePublications = [
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ];
      const filenames = ["consent-report.txt", "consent-notes.txt"];
      const posts: Record<string, unknown>[] = [];
      const statusReads: string[] = [];
      let terminal = false;
      const publicationsPath = `/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`;
      const storageKey = `paperclip:board-send:v1:${JSON.stringify([seed.companyId, issue.id, endpointId, conversationId])}`;
      await page.route("**/api/instance/settings/experimental", (route) =>
        fulfill(route, { enableChatConnectors: true }),
      );
      await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
        fulfill(route, {
          endpointId,
          conversationId,
          provider: "microsoft-teams",
          externalLabel: "Personal file conversation",
          assignedAgentLocked: true,
        }),
      );
      // Only the publication API is simulated. Task creation and safe file
      // uploads use this test's isolated Paperclip instance, never Teams.
      await page.route(`**${publicationsPath}`, (route) => {
        expect(route.request().method()).toBe("POST");
        posts.push(bodyOf(route));
        return fulfill(
          route,
          {
            id: posts.length === 1 ? anchor : nextAnchor,
            state: "pending",
            attempts: 0,
          },
          201,
        );
      });
      await page.route(`**${publicationsPath}/*/status`, (route) => {
        expect(route.request().method()).toBe("GET");
        const path = new URL(route.request().url()).pathname;
        statusReads.push(path);
        if (path.endsWith(`/${nextAnchor}/status`)) {
          return fulfill(route, {
            publication: { id: nextAnchor, state: "pending", attempts: 0 },
            total: 1,
            published: 0,
            awaitingConsent: 0,
            declined: 0,
            expired: 0,
            cancelled: 0,
            settled: 0,
            canDismiss: false,
          });
        }
        expect(path).toBe(`${publicationsPath}/${anchor}/status`);
        const parts = [
          { id: anchor, state: "published", attempts: 1 },
          ...filePublications.map((id, index) => ({
            id,
            state:
              terminal || (cancelledHead && index === 0)
                ? "cancelled"
                : "awaiting_consent",
            attempts: 1,
            fileTransfer: {
              provider: "microsoft-teams",
              filename: filenames[index],
              phase: terminal
                ? index === 0
                  ? "declined"
                  : "expired"
                : cancelledHead && index === 0
                  ? "cancelled"
                  : "awaiting_consent",
              version: terminal ? 3 : 2,
            },
          })),
        ];
        return fulfill(route, {
          publication: parts[1],
          parts,
          total: 3,
          published: 1,
          awaitingConsent: terminal ? 0 : cancelledHead ? 1 : 2,
          declined: terminal ? 1 : 0,
          expired: terminal ? 1 : 0,
          cancelled: !terminal && cancelledHead ? 1 : 0,
          settled: terminal ? 3 : cancelledHead ? 2 : 1,
          canDismiss: terminal,
        });
      });
      await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
      const banner = page.getByRole("region", {
        name: "External conversation",
        exact: true,
      });
      await banner
        .getByRole("button", { name: "Send to channel", exact: true })
        .click();
      for (const name of filenames) {
        await banner
          .getByLabel("Attach file to channel update", { exact: true })
          .setInputFiles({
            name,
            mimeType: "text/plain",
            buffer: Buffer.from(`Synthetic consent fixture: ${name}.\n`),
          });
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).toBeChecked();
        await expect(
          banner.getByLabel("Attach file to channel update", { exact: true }),
        ).toBeEnabled();
      }
      await expect(
        banner.getByRole("group", { name: "Include task files", exact: true }),
      ).toContainText(
        "In personal Teams chats, recipients accept each file before upload. Channels and group chats receive supported images directly; other files stay on the task, with a task link or private-task notice.",
      );
      await banner.screenshot({
        path: testInfo.outputPath("teams-file-guidance.png"),
      });
      expect(posts).toHaveLength(0);
      await banner
        .getByRole("textbox", { name: "Board update", exact: true })
        .fill("Please review these two files.");
      await banner
        .getByRole("button", { name: "Send to channel", exact: true })
        .last()
        .click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0].attachmentIds).toHaveLength(2);
      await expect(
        banner.getByText(
          cancelledHead
            ? "1 published · 1 awaiting consent · 1 cancelled"
            : "1 published · 2 awaiting consent",
          { exact: true },
        ),
      ).toBeVisible();
      const retainedBeforeReload = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        storageKey,
      );
      expect(JSON.parse(retainedBeforeReload!).publication.id).toBe(anchor);
      const readsBeforeReload = statusReads.length;
      await page.reload();
      await expect
        .poll(() => statusReads.length)
        .toBeGreaterThan(readsBeforeReload);
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
      ).toBe(retainedBeforeReload);
      expect(
        statusReads.every(
          (path) => path === `${publicationsPath}/${anchor}/status`,
        ),
      ).toBe(true);
      await expect(
        banner.getByRole("textbox", { name: "Board update", exact: true }),
      ).toBeDisabled();
      await expect(
        banner.getByLabel("Attach file to channel update", { exact: true }),
      ).toBeDisabled();
      await expect(
        banner
          .getByRole("button", { name: "Send to channel", exact: true })
          .last(),
      ).toBeDisabled();
      await expect(
        banner.getByRole("button", {
          name: "Dismiss delivery receipt",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        banner.getByText(
          cancelledHead
            ? "Waiting for remaining file consent"
            : "Waiting for file consent",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        banner.getByText("Channel delivery cancelled", { exact: true }),
      ).toHaveCount(0);
      await expect(
        banner.getByText("Sent to channel", { exact: true }),
      ).toHaveCount(0);
      for (const name of filenames) {
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).toBeChecked();
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).toBeDisabled();
      }
      expect(posts).toHaveLength(1);
      await banner.screenshot({
        path: testInfo.outputPath("consent-waiting.png"),
      });
      if (cancelledHead) return;

      terminal = true;
      await expect(
        banner.getByText("Delivery settled with mixed outcomes", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 8_000 });
      await expect(
        banner.getByText("1 published · 1 declined · 1 expired", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        banner.getByText("consent-report.txt — Declined", { exact: true }),
      ).toBeVisible();
      await expect(
        banner.getByText("consent-notes.txt — Consent expired", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        banner
          .getByRole("button", { name: "Send to channel", exact: true })
          .last(),
      ).toBeDisabled();
      await banner.screenshot({
        path: testInfo.outputPath("consent-mixed.png"),
      });
      expect(posts).toHaveLength(1);
      await banner
        .getByRole("button", { name: "Dismiss delivery receipt", exact: true })
        .click();
      await expect(
        banner.getByRole("textbox", { name: "Board update", exact: true }),
      ).toHaveValue("");
      await expect(
        banner.getByRole("textbox", { name: "Board update", exact: true }),
      ).toBeEnabled();
      await expect(
        banner
          .getByRole("button", { name: "Send to channel", exact: true })
          .last(),
      ).toBeDisabled();
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
      ).toBeNull();
      expect(posts).toHaveLength(1);
      await expect(
        page.getByText("Sent to channel", { exact: true }),
      ).toHaveCount(0);
      for (const name of filenames) {
        await expect(
          banner.getByRole("checkbox", { name, exact: true }),
        ).not.toBeChecked();
      }
      await banner
        .getByRole("textbox", { name: "Board update", exact: true })
        .fill("A separate text-only update.");
      expect(posts).toHaveLength(1);
      await banner
        .getByRole("button", { name: "Send to channel", exact: true })
        .last()
        .click();
      await expect.poll(() => posts.length).toBe(2);
      expect(posts[1]).toMatchObject({
        body: "A separate text-only update.",
      });
      expect(posts[1]).not.toHaveProperty("attachmentIds");
      expect(posts[1].idempotencyKey).not.toBe(posts[0].idempotencyKey);
    });
  }

  for (const outcome of [
    "published",
    "failed",
    "delivery_unknown",
    "response_lost",
  ] as const) {
    test(`tracks the whole file batch across reload and ${outcome} without a new send identity`, async ({
      page,
      request,
    }) => {
      const seed = await seedCompanyAndAgent(request);
      const issue = await json<{ id: string; identifier: string }>(
        await request.post(`/api/companies/${seed.companyId}/issues`, {
          data: { title: "Board delivery refresh", status: "backlog" },
        }),
        "create board-send task",
      );
      const endpointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const publicationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const attachmentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const statusPath = `/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications/${publicationId}/status`;
      let sends = 0;
      const submittedPayloads: Record<string, unknown>[] = [];
      let reads = 0;
      let canonicalAttachmentReadsAfterSend = 0;
      let canonicalCommentReadsAfterSend = 0;
      let status = "streaming";
      await page.route("**/api/instance/settings/experimental", (route) =>
        fulfill(route, { enableChatConnectors: true }),
      );
      await page.route(`**/api/issues/${issue.id}/chat-binding`, (route) =>
        fulfill(route, {
          endpointId,
          conversationId,
          provider: "slack",
          externalLabel: "#board-send-test",
          assignedAgentLocked: true,
        }),
      );
      await page.route(
        new RegExp(
          `/api/issues/(${issue.id}|${issue.identifier})/comments(?:\\?|$)`,
        ),
        async (route) => {
          if (
            sends &&
            route.request().url().includes(`/issues/${issue.identifier}/`)
          )
            canonicalCommentReadsAfterSend += 1;
          await fulfill(
            route,
            sends
              ? [
                  {
                    id: publicationId,
                    companyId: seed.companyId,
                    issueId: issue.id,
                    authorAgentId: null,
                    authorUserId: "local-board",
                    authorType: "user",
                    body: "Board batch must finish all files.",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ]
              : [],
          );
        },
      );
      await page.route(
        new RegExp(
          `/api/issues/(${issue.id}|${issue.identifier})/attachments$`,
        ),
        async (route) => {
          if (
            sends &&
            route.request().url().includes(`/issues/${issue.identifier}/`)
          )
            canonicalAttachmentReadsAfterSend += 1;
          await fulfill(route, [
            {
              id: attachmentId,
              companyId: seed.companyId,
              issueId: issue.id,
              issueCommentId: sends ? publicationId : null,
              assetId: attachmentId,
              provider: "local_disk",
              objectKey: "board-send-test.txt",
              contentType: "text/plain",
              byteSize: 12,
              sha256: "a".repeat(64),
              originalFilename: "board-send-test.txt",
              createdByAgentId: null,
              createdByUserId: "local-board",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contentPath: `/api/attachments/${attachmentId}/content`,
            },
            {
              id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              companyId: seed.companyId,
              issueId: issue.id,
              issueCommentId: null,
              assetId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              provider: "local_disk",
              objectKey: "internal-only.txt",
              contentType: "text/plain",
              byteSize: 8,
              sha256: "b".repeat(64),
              originalFilename: "internal-only.txt",
              createdByAgentId: null,
              createdByUserId: "local-board",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              contentPath:
                "/api/attachments/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/content",
            },
          ]);
        },
      );
      await page.route(
        `**/api/chat-endpoints/${endpointId}/conversations/${conversationId}/publications`,
        async (route) => {
          expect(route.request().method()).toBe("POST");
          expect(bodyOf(route).attachmentIds).toEqual([attachmentId]);
          sends += 1;
          submittedPayloads.push(bodyOf(route));
          if (outcome === "response_lost" && sends === 1) {
            await route.abort("failed");
            return;
          }
          await fulfill(
            route,
            { id: publicationId, state: "streaming", attempts: 1 },
            201,
          );
        },
      );
      await page.route(`**${statusPath}`, async (route) => {
        expect(route.request().method()).toBe("GET");
        reads += 1;
        await fulfill(route, {
          publication: {
            id: status === "streaming" ? publicationId : attachmentId,
            state: status,
            attempts: 1,
          },
          total: 2,
          published: status === "published" ? 2 : 1,
        });
      });
      await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
      await page
        .getByRole("button", { name: "Send to channel", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Board update", exact: true })
        .fill("Board batch must finish all files.");
      await page.getByRole("checkbox", { name: "board-send-test.txt" }).check();
      await page
        .getByRole("button", { name: "Send to channel", exact: true })
        .last()
        .click();
      const expectRetainedFiles = async () => {
        const files = page.getByRole("group", {
          name: "Files in this send",
          exact: true,
        });
        await expect(files).toBeVisible();
        await expect(files.getByRole("checkbox")).toHaveCount(1);
        await expect(
          files.getByRole("checkbox", { name: "board-send-test.txt" }),
        ).toBeChecked();
        await expect(
          files.getByRole("checkbox", { name: "board-send-test.txt" }),
        ).toBeDisabled();
        await expect(
          files.getByText("internal-only.txt", { exact: true }),
        ).toHaveCount(0);
      };
      if (outcome === "response_lost") {
        await expect(
          page.getByText("Delivery result not confirmed", { exact: true }),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toBeDisabled();
        await expectRetainedFiles();
        expect(sends).toBe(1);
        expect(reads).toBe(0);
        await page
          .getByRole("button", { name: "Retry safely", exact: true })
          .click();
        await expect.poll(() => submittedPayloads.length).toBe(2);
        expect(submittedPayloads[1]).toEqual(submittedPayloads[0]);
      } else {
        await expect(
          page.getByText("Publishing to channel", { exact: true }).first(),
        ).toBeVisible();
        // The canonical task view must refresh its comment/files before any reload.
        await expect
          .poll(() => canonicalCommentReadsAfterSend)
          .toBeGreaterThan(0);
        await expect
          .poll(() => canonicalAttachmentReadsAfterSend)
          .toBeGreaterThan(0);
        await expectRetainedFiles();
        const readsBeforeReload = reads;
        await page.reload();
        await expect
          .poll(() => reads, { timeout: 8_000 })
          .toBeGreaterThan(readsBeforeReload);
        expect(sends).toBe(1);
      }
      await expect.poll(() => reads, { timeout: 8_000 }).toBeGreaterThan(0);
      await expectRetainedFiles();
      await expect(
        page.getByRole("textbox", { name: "Board update", exact: true }),
      ).toHaveValue("Board batch must finish all files.");
      await expect(
        page.getByRole("textbox", { name: "Board update", exact: true }),
      ).toBeDisabled();
      status = outcome === "response_lost" ? "published" : outcome;
      if (status === "published") {
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toHaveCount(0, { timeout: 8_000 });
        await expect(
          page.getByText("Sent to channel", { exact: true }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByText(
            outcome === "failed"
              ? "Channel delivery failed"
              : "Delivery not confirmed",
            { exact: true },
          ),
        ).toBeVisible({ timeout: 8_000 });
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toHaveValue("Board batch must finish all files.");
        await expect(
          page
            .getByRole("button", { name: "Send to channel", exact: true })
            .last(),
        ).toBeDisabled();
        await expect(
          page.getByRole("link", { name: "Open Activity", exact: true }),
        ).toBeVisible();
        // An explicit resolution elsewhere may complete the batch; this surface only reads it.
        status = "published";
        await expect(
          page.getByRole("textbox", { name: "Board update", exact: true }),
        ).toHaveCount(0, { timeout: 8_000 });
      }
      expect(sends).toBe(outcome === "response_lost" ? 2 : 1);
      expect(canonicalCommentReadsAfterSend).toBeGreaterThan(0);
      expect(canonicalAttachmentReadsAfterSend).toBeGreaterThan(0);
      await expect(
        page.getByText("Board batch must finish all files.", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Send to channel", exact: true })
        .click();
      const newFiles = page.getByRole("group", {
        name: "Include task files",
        exact: true,
      });
      await expect(
        newFiles.getByRole("checkbox", { name: "board-send-test.txt" }),
      ).toHaveCount(0);
      await expect(
        newFiles.getByRole("checkbox", { name: "internal-only.txt" }),
      ).not.toBeChecked();
      await expect(
        newFiles.getByRole("checkbox", { name: "internal-only.txt" }),
      ).toBeEnabled();
      expect(sends).toBe(outcome === "response_lost" ? 2 : 1);
    });
  }
});

test.describe("Exact failed chat run retry", () => {
  let seed: Seed;
  let issue: { id: string; identifier: string; title: string };

  const failedRunId = "11111111-aaaa-4aaa-8aaa-111111111111";
  const actionId = "22222222-bbbb-4bbb-8bbb-222222222222";
  const denial =
    "This chat source is no longer authorized. Open the task to review its current channel access before retrying.";

  test.beforeAll(async ({ request }) => {
    seed = await seedCompanyAndAgent(request);
    issue = await json<typeof issue>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: "Exact chat retry destination", status: "backlog" },
      }),
      "create exact-retry task",
    );
  });

  for (const surface of ["agent run", "Inbox", "Legacy Inbox"] as const) {
    for (const outcome of ["queued", "deferred", "denied"] as const) {
      test(`${surface}: selected run ${outcome} preserves exact retry authority and truthful feedback`, async ({
        page,
      }, testInfo) => {
        const now = Date.now();
        const run = {
          id: failedRunId,
          companyId: seed.companyId,
          agentId: seed.agentId,
          status: "failed",
          invocationSource: "assignment",
          triggerDetail: "system",
          startedAt: new Date(now - 60_000).toISOString(),
          finishedAt: new Date(now - 30_000).toISOString(),
          createdAt: new Date(now - 60_000).toISOString(),
          updatedAt: new Date(now - 30_000).toISOString(),
          error: "The fixture provider turn failed.",
          errorCode: "adapter_failed",
          exitCode: 1,
          signal: null,
          responsibleUserId: null,
          runtimeMode: "native",
          driverKind: "codex_app_server",
          nativeIssueId: issue.id,
          usageJson: null,
          resultJson: null,
          sessionIdBefore: null,
          sessionIdAfter: null,
          logStore: null,
          logRef: null,
          logBytes: 0,
          retryOfRunId: null,
          scheduledRetryAt: null,
          scheduledRetryAttempt: 0,
          scheduledRetryReason: null,
          contextSnapshot: {
            source: "chat:slack",
            issueId: issue.id,
            taskId: "33333333-cccc-4ccc-8ccc-333333333333",
            taskKey: "untrusted-copy-of-another-task",
            wakeCommentId: "44444444-dddd-4ddd-8ddd-444444444444",
            wakeCommentIds: ["44444444-dddd-4ddd-8ddd-444444444444"],
            chatFailedRunRetry: { actionId: "untrusted-client-action" },
          },
        };
        const requests: Array<{
          companyId: string | null;
          body: Record<string, unknown>;
        }> = [];
        const destinations: string[] = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) destinations.push(frame.url());
        });
        await page.route("**/api/**", async (route) => {
          const url = new URL(route.request().url());
          const pathname = url.pathname;
          if (pathname === "/api/instance/settings/experimental") {
            await fulfill(route, {
              enableChatConnectors: true,
              enableStreamlinedUi: surface !== "Legacy Inbox",
            });
            return;
          }
          if (pathname === `/api/companies/${seed.companyId}/heartbeat-runs`) {
            await fulfill(route, [run]);
            return;
          }
          if (pathname === `/api/heartbeat-runs/${failedRunId}`) {
            await fulfill(route, run);
            return;
          }
          if (
            pathname === `/api/heartbeat-runs/${failedRunId}/events` ||
            pathname ===
              `/api/heartbeat-runs/${failedRunId}/workspace-operations` ||
            pathname === `/api/companies/${seed.companyId}/provider-traces`
          ) {
            await fulfill(route, []);
            return;
          }
          if (pathname === `/api/heartbeat-runs/${failedRunId}/issues`) {
            await fulfill(route, [
              {
                issueId: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                status: "backlog",
                priority: "medium",
              },
            ]);
            return;
          }
          if (pathname === `/api/heartbeat-runs/${failedRunId}/log`) {
            await fulfill(route, {
              runId: failedRunId,
              content: "",
              nextOffset: 0,
            });
            return;
          }
          if (pathname === `/api/agents/${seed.agentId}/wakeup`) {
            expect(route.request().method()).toBe("POST");
            requests.push({
              companyId: url.searchParams.get("companyId"),
              body: bodyOf(route),
            });
            if (outcome === "denied") {
              await fulfill(
                route,
                {
                  error: denial,
                  details: { code: "chat_failed_run_retry_source_denied" },
                },
                409,
              );
            } else {
              // The durable action exists, but no run has been admitted yet.
              await fulfill(
                route,
                { actionId, issueId: issue.id, runId: null, status: outcome },
                202,
              );
            }
            return;
          }
          await route.continue();
        });

        const startPath =
          surface === "agent run"
            ? `/${seed.prefix}/agents/${seed.agentId}/runs/${failedRunId}`
            : `/${seed.prefix}/inbox/all`;
        await page.goto(startPath);
        const retry = page
          .getByRole("button", { name: "Retry", exact: true })
          .filter({ visible: true });
        await expect(retry).toHaveCount(1);
        await retry.click();
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0]).toEqual({
          companyId: seed.companyId,
          body: {
            source: "on_demand",
            triggerDetail: "manual",
            reason: "retry_failed_run",
            failedRunId,
          },
        });
        if (outcome === "denied") {
          await expect(page.getByText(denial, { exact: true })).toBeVisible();
          if (surface !== "agent run") {
            await expect(
              page.getByText("Run retry failed", { exact: true }),
            ).toBeVisible();
            const toast = page.getByRole("listitem").filter({
              has: page.getByText("Run retry failed", { exact: true }),
            });
            // Visibility alone accepts opacity:0 during the toast entrance.
            // The operator must actually be able to read the denial.
            await expect(toast).toHaveCSS("opacity", "1");
            await expect(toast).toBeInViewport();
          }
          // Agent routes canonicalize the UUID to its human-readable URL key.
          // The selected failed run must remain unchanged across that redirect.
          await expect(page).toHaveURL(
            surface === "agent run"
              ? new RegExp(
                  `/${seed.prefix}/agents/(${seed.agentId}|maya)/runs/${failedRunId}$`,
                )
              : new RegExp(`${startPath}$`),
          );
          await expect(retry).toBeEnabled();
          await testInfo.attach(`${surface}-retry-denied`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        } else {
          await expect(page).toHaveURL(
            new RegExp(
              `/${seed.prefix}/issues/(${issue.id}|${issue.identifier})$`,
            ),
          );
          await expect(
            page.getByText(issue.title, { exact: true }).first(),
          ).toBeVisible();
          await expect(
            page.getByText("Run retry failed", { exact: true }),
          ).toHaveCount(0);
        }
        expect(requests).toHaveLength(1);
        expect(
          destinations.some((url) =>
            /\/runs\/(null|undefined)(?:[/?#]|$)/.test(url),
          ),
        ).toBe(false);
      });
    }
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
