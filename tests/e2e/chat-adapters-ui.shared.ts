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

export type Provider = "slack" | "github" | "discord" | "microsoft-teams" | "telegram" | "imessage-photon";

export const GITHUB_PRIVATE_KEY_FIXTURE =
  "-----BEGIN PRIVATE KEY-----\nlocal-e2e-key\n-----END PRIVATE KEY-----\n";
export const GITHUB_PRIVATE_KEY_PASTE_FIXTURE =
  "-----BEGIN PRIVATE KEY-----\nlocal-e2e-pasted-key\n-----END PRIVATE KEY-----\n";

export type ProviderCase = {
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

export const PROVIDERS: ProviderCase[] = [
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
    setupHeading: /Create a Slack app/i,
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

export const PROVIDER_LIFECYCLE_COPY: Record<
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

export type Seed = {
  companyId: string;
  prefix: string;
  agentId: string;
  otherAgentId: string;
};

export async function json<T>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  label: string,
): Promise<T> {
  expect(
    response.ok(),
    `${label} failed ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as T;
}

export async function seedCompanyAndAgent(request: APIRequestContext): Promise<Seed> {
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

export function bodyOf(route: Route): Record<string, unknown> {
  return route.request().postDataJSON() as Record<string, unknown>;
}

export async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export function endpointFixture(provider: ProviderCase, seed: Seed) {
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
      testStartedAt: null as string | null,
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

export type ChatMock = {
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
  setWebhookVerified: () => void;
};

export async function installChatControlPlaneMock(
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
  let slackIdentityLinked = false;
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
    setWebhookVerified: () => {
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
          testStartedAt: body.action === "verify" ? new Date().toISOString() : endpoint.setup.testStartedAt,
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
      (pathname === `/api/chat-endpoints/${endpoint.id}/test` || pathname === `/api/chat-endpoints/${endpoint.id}/finish`) &&
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

    if (pathname === `/api/chat-endpoints/${endpoint.id}/test-status`) {
      await fulfill(route, { messageReceivedAt: null });
      return;
    }
    if (pathname === `/api/chat-endpoints/${endpoint.id}/principals/principal-slack-self/link-intent` && method === "POST") {
      await fulfill(route, { confirmationUrl: `https://paperclip.example.test/${seed.prefix}/chat-identity/confirm?token=e2e-self` });
      return;
    }
    if (pathname === "/api/chat-identity-links/confirm" && method === "POST") {
      slackIdentityLinked = true;
      await fulfill(route, { endpointId: endpoint.id, companyId: seed.companyId });
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
          ...(provider.provider === "slack" && (slackIdentityLinked || endpoint.setup.step === "test") ? [{
            id: "link-slack-self", principalId: "principal-slack-self", externalLabel: "Test operator",
            externalDetail: "operator@slack", lastConnectAt: new Date().toISOString(),
            paperclipUserId: slackIdentityLinked ? "local-board" : null,
            status: slackIdentityLinked ? "linked" : "pending",
          }] : []),
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

export async function selectMaya(page: Page) {
  await page.getByRole("button", { name: "Choose an active agent" }).click();
  await page.getByRole("button", { name: "Select Maya" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

export async function fillProviderSetup(page: Page, provider: ProviderCase) {
  if (provider.provider === "slack") {
    await page.getByRole("button", { name: "I already created the app" }).click();
    await expect(page.getByLabel("Bot User OAuth Token")).toHaveAttribute("type", "password");
    await expect(page.getByLabel("Signing Secret")).toHaveAttribute("type", "password");
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

export function expectedCredentialKeys(provider: Provider): string[] {
  if (provider === "slack") return ["botToken", "signingSecret"];
  if (provider === "github") return ["appId", "privateKey"];
  if (provider === "microsoft-teams")
    return ["clientId", "clientSecret", "tenantId"];
  if (provider === "discord") return ["applicationId", "botToken", "guildId"];
  return ["botToken"];
}

export async function expectSetupRail(page: Page) {
  const rail = page.getByRole("navigation", { name: "Connection setup progress" });
  await expect(rail).toBeVisible();
  const labels = new URL(page.url()).searchParams.get("provider") === "slack"
    ? ["Choose agent", "Create Slack app", "Add credentials", "Verify Slack connection", "Connect your Slack account", "Try it"]
    : ["Choose agent", "Connect provider", "Try it"];
  await expect(rail.getByRole("listitem")).toHaveCount(labels.length);
  for (const label of labels) {
    await expect(rail.getByText(label, { exact: true })).toBeVisible();
  }
}

export function expectedSlackManifest(webhookUrl: string) {
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
      description: "Start or manage work with Maya"
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

export async function expectMinimumProviderSetup(page: Page, provider: ProviderCase) {
  const webhookUrl = `https://paperclip.example.test/api/chat-webhooks/public-${provider.provider}/${provider.provider}`;
  if (provider.provider === "slack") {
    await expect(page.getByLabel("Slack app name", { exact: true })).toBeEditable();
    await expect(page.getByLabel("Bot display name", { exact: true })).toBeEditable();
    await expect(page.getByLabel("Slash command", { exact: true })).toBeEditable();
    await page.getByRole("button", { name: "View Slack App Manifest" }).click();
    const manifest = page.getByRole("textbox", { name: "Slack app manifest", exact: true });
    await expect(manifest).toHaveValue(expectedSlackManifest(webhookUrl));
    await expect(manifest).toHaveAttribute("readonly", "");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Create Slack app", exact: true })).toBeVisible();
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

export async function expectProviderTryInstructions(
  page: Page,
  provider: ProviderCase,
) {
  if (provider.provider === "slack") {
    for (const text of ["Open a channel and invite @maya-paperclip if needed.", "@maya-paperclip you there?", "Continue the conversation in the thread."]) {
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Slack", exact: true })).toHaveCount(0);
    return;
  }
  const expected =
    provider.provider === "github"
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
