import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import {
  APP_STORE_DEFINITIONS,
  APP_STORE_HIDDEN_SLUGS,
  CONNECTABLE_APP_DEFINITIONS,
  appSupportsCatalogSetup,
  getAvailableConnectionMethod,
  getAvailableConnectionMethods,
  getAppDefinitionForUrl,
  getConnectableAppDefinition,
  getRecommendedConnectionMethod,
  recommendedDefaultsForApp,
  resolveConnectionMethodServerUrl,
} from "./app-definitions.js";
import {
  GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  type GoogleWorkspaceConnectorProfileId,
} from "./google-workspace-connectors.js";
import {
  BLOCKED_MCP_PROVIDERS,
  SELF_SERVE_MCP_CANDIDATES,
  SELF_SERVE_MCP_RESEARCH,
} from "./self-serve-mcp-research.js";
import { aiConnectionRouterAppDefinition } from "./ai-connection-router.js";
import { appDefinitionSchema, appDefinitionsSchema } from "./validators/app-definition.js";

const googleScope = (scope: string) =>
  `https://www.googleapis.com/auth/${scope}`;
const GOOGLE_WORKSPACE_PROFILE_EXPECTATIONS = [
  {
    profile: "gmail.read",
    appSlug: "gmail",
    serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("gmail.readonly")],
    writeTools: [],
  },
  {
    profile: "gmail.draft",
    appSlug: "gmail",
    serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    capability: "draft",
    riskTier: "S4",
    scopes: [googleScope("gmail.readonly"), googleScope("gmail.compose")],
    writeTools: ["create_draft"],
  },
  {
    profile: "drive.read",
    appSlug: "google-drive",
    serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("drive.readonly")],
    writeTools: [],
  },
  {
    profile: "drive.write",
    appSlug: "google-drive",
    serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [googleScope("drive.readonly"), googleScope("drive.file")],
    writeTools: ["copy_file", "create_file"],
  },
  {
    profile: "docs.read",
    appSlug: "google-docs",
    serverUrl: "https://docsmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("documents.readonly")],
    writeTools: [],
  },
  {
    profile: "docs.write",
    appSlug: "google-docs",
    serverUrl: "https://docsmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [googleScope("documents")],
    writeTools: ["update_doc"],
  },
  {
    profile: "sheets.read",
    appSlug: "google-sheets",
    serverUrl: "https://sheetsmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("spreadsheets.readonly")],
    writeTools: [],
  },
  {
    profile: "sheets.write",
    appSlug: "google-sheets",
    serverUrl: "https://sheetsmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [googleScope("spreadsheets")],
    writeTools: [
      "update_spreadsheet",
      "update_values",
      "update_formulas",
      "insert_dimension",
    ],
  },
  {
    profile: "slides.read",
    appSlug: "google-slides",
    serverUrl: "https://slidesmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [googleScope("presentations.readonly")],
    writeTools: [],
  },
  {
    profile: "slides.write",
    appSlug: "google-slides",
    serverUrl: "https://slidesmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [googleScope("presentations")],
    writeTools: ["update_presentation"],
  },
  {
    profile: "calendar.read",
    appSlug: "google-calendar",
    serverUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("calendar.calendarlist.readonly"),
      googleScope("calendar.events.freebusy"),
      googleScope("calendar.events.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "calendar.write",
    appSlug: "google-calendar",
    serverUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [
      googleScope("calendar.calendarlist.readonly"),
      googleScope("calendar.events"),
    ],
    writeTools: [
      "create_event",
      "update_event",
      "delete_event",
      "respond_to_event",
    ],
  },
  {
    profile: "chat.read",
    appSlug: "google-chat",
    serverUrl: "https://chatmcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("chat.spaces.readonly"),
      googleScope("chat.messages.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "chat.write",
    appSlug: "google-chat",
    serverUrl: "https://chatmcp.googleapis.com/mcp/v1",
    capability: "write",
    riskTier: "S4",
    scopes: [
      googleScope("chat.spaces.readonly"),
      googleScope("chat.messages.readonly"),
      googleScope("chat.messages.create"),
    ],
    writeTools: ["send_message"],
  },
  {
    profile: "people.read",
    appSlug: "google-people",
    serverUrl: "https://people.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("directory.readonly"),
      googleScope("userinfo.profile"),
      googleScope("contacts.readonly"),
    ],
    writeTools: [],
  },
  {
    profile: "workspace-search.read",
    appSlug: "google-workspace-search",
    serverUrl: "https://workspacemcp.googleapis.com/mcp/v1",
    capability: "read",
    riskTier: "S3",
    scopes: [
      googleScope("gmail.readonly"),
      googleScope("drive.readonly"),
      googleScope("calendar.readonly"),
      googleScope("chat.messages.readonly"),
    ],
    writeTools: [],
  },
] as const satisfies ReadonlyArray<{
  profile: GoogleWorkspaceConnectorProfileId;
  appSlug: string;
  serverUrl: string;
  capability: "read" | "write" | "draft";
  riskTier: "S3" | "S4";
  scopes: readonly string[];
  writeTools: readonly string[];
}>;
describe("AppDefinition catalog", () => {
  it("namespaces Browser Use's hosted service as browser-use-cloud", () => {
    expect(CONNECTABLE_APP_DEFINITIONS.find(app => app.slug === "browser-use-cloud"))
      .toMatchObject({ name: "Browser Use Cloud", methods: [{ key: "cloud-v4", transport: "rest_api" }] });
    expect(APP_DEFINITIONS.some(app => app.slug === "browser-use")).toBe(false);
    expect(getAppDefinitionForUrl("https://cloud.browser-use.com/agents")?.slug).toBe("browser-use-cloud");
  });
  it("offers Anthropic runtime authentication without the unsupported REST tool method", () => {
    const anthropic = APP_DEFINITIONS.find((app) => app.slug === "anthropic")!;
    expect(anthropic.methods.map((method) => method.key)).toEqual(["ai-subscription", "ai-api_key"]);
    expect(anthropic.methods.every((method) => method.purpose === "ai" && method.transport === "runtime_auth")).toBe(true);
    expect(getAvailableConnectionMethod(anthropic, "api-key")).toBeNull();
  });

  it("validates all Wave 1 definitions", () =>
    expect(() => appDefinitionsSchema.parse(APP_DEFINITIONS)).not.toThrow());
  it("lists model providers as regular tagged catalog entries", () => {
    const slugs = ["openai", "anthropic", "openrouter", "xai", "google", "bedrock", "responses-api", "messages-api", "chat-completions-api", "local"];
    expect(APP_STORE_DEFINITIONS.filter(app => app.tags?.includes("model-provider")).map(app => app.slug).sort()).toEqual(slugs.sort());
    for (const slug of slugs) {
      const app = APP_STORE_DEFINITIONS.find(app => app.slug === slug)!;
      expect(app.methods.some(method => method.purpose === "ai" && method.transport === "runtime_auth")).toBe(true);
    }
  });

  it("contains every established provider plus the reviewed self-serve catalog", () => {
    expect(APP_DEFINITIONS.map((app) => app.slug)).toEqual(
      expect.arrayContaining([
        "zapier",
        "github",
        "discord",
        "slack",
        "microsoft-teams",
        "telegram",
        "notion",
        "posthog",
        "linear",
        "google-sheets",
        "context7",
        "composio",
        "oauth-generic",
        "api-key-generic",
        "sentry",
        "vercel",
        "anthropic",
        "gmail",
        "google-drive",
        "google-docs",
        "google-slides",
        "google-calendar",
        "google-chat",
        "google-people",
        "google-workspace-search",
      ]),
    );
    expect(SELF_SERVE_MCP_CANDIDATES).toHaveLength(52);
    expect(BLOCKED_MCP_PROVIDERS.map((entry) => entry.slug)).toEqual([
      "g2",
      "vercel",
      "zomato",
    ]);
    const definitionSlugs = new Set(APP_DEFINITIONS.map((app) => app.slug));
    const connectableSlugs = new Set(
      CONNECTABLE_APP_DEFINITIONS.map((app) => app.slug),
    );
    expect(
      SELF_SERVE_MCP_CANDIDATES.filter(
        (entry) => !definitionSlugs.has(entry.slug),
      ),
    ).toEqual([]);
    expect(
      SELF_SERVE_MCP_CANDIDATES.filter(
        (entry) => !connectableSlugs.has(entry.slug),
      ),
    ).toEqual([]);
    for (const entry of BLOCKED_MCP_PROVIDERS)
      expect(connectableSlugs.has(entry.slug)).toBe(false);
  });
  it("separates GitHub tools from the review bot without changing the provider identity", () => {
    const github = getConnectableAppDefinition("github")!;
    const bot = getConnectableAppDefinition("github-code-review-bot")!;
    expect(github.methods.map((method) => method.key)).toEqual(["managed", "mcp-key"]);
    expect(github.methods.every((method) => method.purpose === "tool")).toBe(true);
    expect(bot.name).toBe("GitHub Code Review Bot");
    expect(bot.methods).toHaveLength(1);
    expect(bot.methods[0]).toMatchObject({ provider: "github", purpose: "channel", transport: "chat_sdk" });
    expect(bot.branding).toEqual(github.branding);
    expect(bot.urlPatterns).toEqual([]);
  });
  it("registers the five native chat providers with only required setup credentials", () => {
    const expected = {
      slack: {
        credentials: ["botToken", "signingSecret"],
        publicFields: [],
        resources: ["workspace", "channel"],
        tool: true,
      },
      "github-code-review-bot": {
        credentials: ["appId", "privateKey"],
        publicFields: ["appId"],
        resources: ["organization", "repository"],
        tool: false,
      },
      discord: {
        credentials: ["botToken", "applicationId", "guildId"],
        publicFields: ["applicationId", "guildId"],
        resources: ["channel"],
        tool: false,
      },
      "microsoft-teams": {
        credentials: ["clientId", "tenantId", "clientSecret"],
        publicFields: ["clientId", "tenantId"],
        resources: ["team", "channel", "chat"],
        tool: false,
      },
      telegram: {
        credentials: ["botToken"],
        publicFields: [],
        resources: ["chat", "group", "topic"],
        tool: false,
      },
    } as const;
    for (const [slug, contract] of Object.entries(expected)) {
      const app = CONNECTABLE_APP_DEFINITIONS.find(
        (candidate) => candidate.slug === slug,
      );
      const channel = app?.methods.find(
        (candidate) => candidate.purpose === "channel",
      );
      expect(app, slug).toBeTruthy();
      expect(channel, slug).toMatchObject({
        key: "chat-agent",
        label: "Chat with an agent",
        purpose: "channel",
        provider: slug === "github-code-review-bot" ? "github" : slug,
        transport: "chat_sdk",
        auth: "api_key",
        ownershipModes: ["customer"],
        requiredResourceFilters: contract.resources,
      });
      expect(
        channel?.credentialFields?.map((field) => field.key),
        slug,
      ).toEqual(contract.credentials);
      expect(
        channel?.credentialFields?.every((field) => field.required),
        slug,
      ).toBe(true);
      for (const field of channel?.credentialFields ?? []) {
        if ((contract.publicFields as readonly string[]).includes(field.key))
          expect(field, `${slug}/${field.key}`).toMatchObject({
            type: "text",
            secret: false,
          });
        else expect(field.secret, `${slug}/${field.key}`).toBe(true);
      }
      expect(channel?.keyPlacement, slug).toBeUndefined();
      const toolMethods =
        app?.methods.filter(
          (candidate) => (candidate.purpose ?? "tool") === "tool",
        ) ?? [];
      expect(toolMethods.length > 0, `${slug}: tool surface`).toBe(
        contract.tool,
      );
      if (contract.tool)
        expect(
          toolMethods.some(
            (candidate) =>
              candidate.label === "Use this connection as an agent tool",
          ),
          slug,
        ).toBe(true);
    }
  });
  it("documents the minimum provider-owned chat app setup without broader permissions", () => {
    const channel = (slug: string) =>
      APP_DEFINITIONS.find((app) => app.slug === slug)?.methods.find(
        (method) => method.purpose === "channel",
      );
    expect(channel("github-code-review-bot")?.guidanceMd).toContain("issue_comment");
    expect(channel("discord")?.guidanceMd).toContain("Message Content intent");
    expect(channel("discord")?.guidanceMd).toContain("Discord thread");
    expect(channel("github-code-review-bot")?.guidanceMd).toContain("pull_request");
    expect(channel("github-code-review-bot")?.guidanceMd).toContain(
      "pull_request_review_comment",
    );
    expect(channel("github-code-review-bot")?.guidanceMd).toContain(
      "installation_repositories",
    );
    expect(channel("github-code-review-bot")?.guidanceMd).toContain(
      "Generate the webhook secret in Paperclip",
    );
    expect(channel("github-code-review-bot")?.guidanceMd).toContain("SSL-verified");
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "resource-specific",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "ChannelMessage.Read.Group",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "ChatMessage.Read.Chat",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "work or school organization",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain("teams.live.com");
    expect(channel("microsoft-teams")?.guidanceMd).toContain("groupChat");
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "receive every message",
    );
    expect(channel("microsoft-teams")?.guidanceMd).toContain(
      "One team install covers its standard channels",
    );
    expect(channel("telegram")?.guidanceMd).toContain(
      "public Paperclip webhook endpoint",
    );
    expect(channel("slack")?.guidanceMd).toContain("reactions");
    expect(channel("slack")?.guidanceMd).toContain("direct messages");
  });
  it("keeps a complete, unique, dated evidence ledger for all 55 researched MCP providers", () => {
    // Ledger-wide date reflects the last full re-verification (2026-08-26);
    // later provider additions carry their own research evidence, but
    // bumping the shared date would overstate freshness for the other providers.
    expect(SELF_SERVE_MCP_RESEARCH.verifiedAt).toBe("2026-08-26");
    expect(SELF_SERVE_MCP_RESEARCH.entries).toHaveLength(55);
    expect(
      new Set(SELF_SERVE_MCP_RESEARCH.entries.map((entry) => entry.slug)),
    ).toHaveProperty("size", 55);
    for (const entry of SELF_SERVE_MCP_RESEARCH.entries) {
      expect(new URL(entry.docsUrl).protocol).toBe("https:");
      expect(new URL(entry.serverUrl).protocol).toBe("https:");
      expect(entry.authMode).toBeTruthy();
      expect(entry.prerequisite.length).toBeGreaterThan(10);
      expect(["S1", "S2", "S3", "S4"]).toContain(entry.riskTier);
    }
  });
  it("offers Fireflies browser sign-in and a vaulted bearer key on the same official MCP endpoint", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "fireflies")!;
    expect(getAppDefinitionForUrl("https://api.fireflies.ai/mcp")?.slug).toBe("fireflies");
    expect(app.methods.map((method) => method.key)).toEqual(["mcp-oauth", "mcp-api-key"]);
    expect(app.methods[0]).toMatchObject({
      transport: "mcp_remote", auth: "oauth", ownershipModes: ["dcr"],
      defaults: { serverUrl: "https://api.fireflies.ai/mcp", scopesHint: ["email", "profile"] },
    });
    expect(app.methods[1]).toMatchObject({
      auth: "api_key", defaults: { serverUrl: "https://api.fireflies.ai/mcp" },
      credentialFields: [{ key: "authorization", secret: true, type: "password", required: true }],
      keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " },
    });
  });

  it("supports organization tokens and OAuth for the official read-only Enterpret MCP", () => {
    const app = CONNECTABLE_APP_DEFINITIONS.find(
      (entry) => entry.slug === "enterpret",
    )!;
    expect(
      getAppDefinitionForUrl("https://wisdom-api.enterpret.com/server/mcp")
        ?.slug,
    ).toBe("enterpret");
    // Both methods target the official read-only MCP, not the beta Agent MCP.
    expect(app.methods.map((method) => method.key)).toEqual([
      "mcp-api-key",
      "mcp-oauth",
    ]);
    expect(app.redirectConstraints).toBe("https-or-loopback-http");
    expect(APP_STORE_HIDDEN_SLUGS.has("enterpret")).toBe(false);
    expect(app.availability?.available).not.toBe(false);
    expect(app.ownershipAvailability?.dcr).not.toBe(false);
    expect(getAvailableConnectionMethods(app).map((method) => method.key)).toEqual([
      "mcp-api-key",
      "mcp-oauth",
    ]);
    expect(getAvailableConnectionMethod(app)?.key).toBe("mcp-api-key");
    expect(getAvailableConnectionMethod(app, "mcp-oauth")?.key).toBe("mcp-oauth");
    expect(app.methods[0]).toMatchObject({
      transport: "mcp_remote",
      auth: "api_key",
      ownershipModes: ["customer"],
      grantKinds: ["organization"],
      riskTier: "S3",
      defaults: { serverUrl: "https://wisdom-api.enterpret.com/server/mcp" },
      credentialFields: [
        { key: "authorization", type: "password", required: true, secret: true },
      ],
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
    });
    expect(app.methods[1]).toMatchObject({
      transport: "mcp_remote",
      auth: "oauth",
      // Enterpret documents no customer-registered OAuth app, only RFC 7591.
      ownershipModes: ["dcr"],
      grantKinds: ["user"],
      riskTier: "S3",
      defaults: {
        serverUrl: "https://wisdom-api.enterpret.com/server/mcp",
        // Narrower than the "mcp:read mcp:write" the 401 challenge advertises.
        scopesHint: ["mcp:read"],
      },
    });
    // RFC 9728 -> RFC 8414 discovery resolves from the challenge, so shipping a
    // complete endpoint pair would suppress discovery permanently.
    expect(app.methods[1].defaults?.authorizationEndpoint).toBeUndefined();
    expect(app.methods[1].defaults?.tokenEndpoint).toBeUndefined();
    expect(app.methods[1].label).toBe("Sign in with Enterpret");
    expect(app.methods[1].warnings?.some((w) => /broader OAuth scopes/i.test(w))).toBe(
      true,
    );
    // The definition records the placement of a credential, never a value.
    const serialized = JSON.stringify(app);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/);
    // "Bearer " may appear only as the header prefix, never trailed by a value.
    expect(serialized.match(/Bearer[^"]*/g)).toEqual(["Bearer "]);
    for (const method of app.methods)
      for (const credentialField of method.credentialFields ?? [])
        expect(credentialField).not.toHaveProperty("defaultValue");
  });

  it("uses the reviewed current endpoints and configuration modes", () => {
    const method = (slug: string, key?: string) =>
      APP_DEFINITIONS.find((app) => app.slug === slug)?.methods.find(
        (candidate) => !key || candidate.key === key,
      );
    expect(method("jira")?.defaults?.serverUrl).toBe(
      "https://mcp.atlassian.com/v1/mcp/authv2",
    );
    expect(method("jira")?.defaults?.scopesHint).toEqual([
      "read:me",
      "read:account",
      "offline_access",
      "email",
      "read:jira-work",
      "write:jira-work",
      "search:confluence",
      "read:confluence-user",
      "read:page:confluence",
      "write:page:confluence",
      "read:comment:confluence",
      "write:comment:confluence",
      "read:space:confluence",
      "read:hierarchical-content:confluence",
      "write:component:compass",
      "read:component:compass",
      "read:scorecard:compass",
      "write:scorecard:compass",
      "read:event:compass",
      "read:metric:compass",
      "read:all:twg",
      "write:all:twg",
    ]);
    expect(method("cloudinary")?.defaults?.serverUrl).toBe(
      "https://asset-management.mcp.cloudinary.com/mcp",
    );
    expect(method("kernel")?.defaults?.serverUrl).toBe(
      "https://mcp.onkernel.com/mcp",
    );
    expect(method("resend")?.defaults?.serverUrl).toBe(
      "https://mcp.resend.com/mcp",
    );
    expect(method("clickhouse")?.defaults?.serverUrl).toBe(
      "https://mcp.clickhouse.cloud/clickstack",
    );
    expect(method("clickhouse")?.tenantFields?.[0]?.transport).toEqual({
      location: "header",
      name: "x-service-id",
    });
    expect(method("mem0")).toMatchObject({
      auth: "api_key",
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
    });
    expect(method("mem0")?.defaults?.serverUrl).toBe(
      "https://mcp.mem0.ai/mcp/",
    );
    expect(method("xero")?.defaults?.scopesHint).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.settings",
      "accounting.invoices.read",
      "accounting.reports.aged.read",
      "accounting.reports.balancesheet.read",
      "accounting.reports.profitandloss.read",
    ]);
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "pagerduty")?.methods.map(
        (candidate) => ({
          key: candidate.key,
          serverUrl: candidate.defaults?.serverUrl,
        }),
      ),
    ).toEqual([
      { key: "mcp-api-key-us", serverUrl: "https://mcp.pagerduty.com/mcp" },
      { key: "mcp-api-key-eu", serverUrl: "https://mcp.eu.pagerduty.com/mcp" },
    ]);
    expect(method("context7")).toMatchObject({
      auth: "none",
      defaults: { serverUrl: "https://mcp.context7.com/mcp" },
    });
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "planetscale")?.methods.map(
        (candidate) => candidate.key,
      ),
    ).toEqual(["mcp-oauth", "mcp-insights-only"]);
    const postman = APP_DEFINITIONS.find((app) => app.slug === "postman");
    expect(postman?.methods.map((candidate) => candidate.key)).toEqual([
      "mcp-oauth-minimal",
      "mcp-oauth-code",
      "mcp-oauth-full",
      "mcp-eu-key-minimal",
      "mcp-eu-key-code",
      "mcp-eu-key-full",
    ]);
    expect(getAvailableConnectionMethod(postman!)?.key).toBe("mcp-oauth-full");
    expect(
      postman?.methods
        .filter((candidate) => candidate.auth === "api_key")
        .every(
          (candidate) =>
            candidate.keyPlacement?.name === "Authorization" &&
            candidate.keyPlacement.prefix === "Bearer ",
        ),
    ).toBe(true);
    expect(
      method("supabase")?.tenantFields?.find(
        (field) => field.key === "readOnly",
      )?.defaultValue,
    ).toBe(false);
    expect(method("asana")).toMatchObject({
      key: "managed", ownershipModes: ["platform_shared"], connectorProfile: "asana.mcp",
      defaults: { serverUrl: "https://mcp.asana.com/v2/mcp", scopesHint: ["default"] },
    });
    expect(APP_DEFINITIONS.find((app) => app.slug === "asana")?.methods[1]).toMatchObject({
      key: "mcp-own-oauth", ownershipModes: ["customer"], oauthClientSecretRequired: true,
      defaults: { discoveryUrl: "https://mcp.asana.com/.well-known/oauth-protected-resource/v2" },
      consoleLinks: { register: "https://app.asana.com/0/my-apps" },
    });
    expect(method("linear")?.ownershipModes).toEqual(["dcr", "customer"]);
    expect(method("zapier")).toMatchObject({
      key: "generated-url",
      auth: "none",
      defaults: {},
    });
    expect(method("zapier")?.credentialFields).toBeUndefined();
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "youcom")?.methods.map(
        (candidate) => candidate.key,
      ),
    ).toEqual(["mcp-oauth", "mcp-api-key", "mcp-free"]);
    expect(method("youcom")?.defaults?.serverUrl).toBe("https://api.you.com/mcp");
    expect(method("youcom", "mcp-api-key")).toMatchObject({
      auth: "api_key",
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
    });
    expect(method("youcom", "mcp-free")).toMatchObject({
      auth: "none",
      defaults: { serverUrl: "https://api.you.com/mcp?profile=free" },
    });
    expect(method("youcom", "mcp-free")?.credentialFields).toBeUndefined();
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "telem")?.methods.map(
        (candidate) => candidate.key,
      ),
    ).toEqual(["mcp-api-key"]);
    expect(method("telem")).toMatchObject({
      auth: "api_key",
      defaults: { serverUrl: "https://mcp.telem.ai/mcp" },
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
      consoleLinks: { keys: "https://app.telem.ai" },
    });
    expect(
      method("telem")?.tenantFields?.map((field) => [
        field.key,
        field.required ?? false,
        field.transport?.location,
        field.transport?.name,
      ]),
    ).toEqual([
      ["autoRouting", false, "header", "X-Telem-Auto-Routing"],
      ["tier", false, "header", "X-Telem-Tier"],
      ["providersInclude", false, "header", "X-Telem-Providers-Include"],
      ["providersExclude", false, "header", "X-Telem-Providers-Exclude"],
    ]);
  });
  it("uses discovery-first Notion MCP OAuth metadata", () => {
    const notion = APP_DEFINITIONS.find((app) => app.slug === "notion");
    expect(notion?.redirectConstraints).toBe("https-or-loopback-http");
    expect(notion?.methods[0]?.defaults).toEqual({
      serverUrl: "https://mcp.notion.com/mcp",
      scopesHint: ["default"],
    });
  });
  it("preserves required Linear OAuth scopes", () =>
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "linear")?.methods[0]?.defaults
        ?.scopesHint,
    ).toEqual(["read", "write"]));
  it("requests Hugging Face MCP read, contribution and job scopes", () =>
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "hugging-face")?.methods[0]
        ?.defaults?.scopesHint,
    ).toEqual(["read-mcp", "read-repos", "contribute-repos", "jobs"]));
  it("defaults every new connection action to allowed except Enterpret writes", () => {
    for (const app of APP_DEFINITIONS)
      for (const method of app.methods) {
        if (app.slug === "enterpret") {
          expect(recommendedDefaultsForApp(app, method.key)).toEqual({
            access: "all_agents",
            askFirstRiskLevels: ["write", "destructive"],
          });
          continue;
        }
        expect(recommendedDefaultsForApp(app, method.key)).toEqual({
          access: "all_agents",
          askFirstRiskLevels: [],
        });
      }
  });
  it("defaults explicit read/write capability groups to their write-capable method", () => {
    const drive = APP_DEFINITIONS.find((app) => app.slug === "google-drive")!;
    const gmail = APP_DEFINITIONS.find((app) => app.slug === "gmail")!;
    expect(getAvailableConnectionMethod(drive)?.key).toBe(
      "customer-write-oauth",
    );
    expect(getAvailableConnectionMethod(gmail)?.key).toBe(
      "customer-draft-oauth",
    );
    expect(
      getRecommendedConnectionMethod(
        drive.methods.filter((candidate) =>
          candidate.ownershipModes.includes("customer"),
        ),
      )?.key,
    ).toBe("customer-write-oauth");
    expect(
      getRecommendedConnectionMethod(
        gmail.methods.filter((candidate) =>
          [
            "paperclip-read",
            "customer-read-oauth",
            "customer-draft-oauth",
          ].includes(candidate.key),
        ),
      )?.key,
    ).toBe("customer-draft-oauth");
    expect(
      getRecommendedConnectionMethod(
        gmail.methods.filter(
          (candidate) => candidate.capabilityProfile?.key === "draft",
        ),
      )?.key,
    ).toBe("paperclip-draft");
    expect(
      getRecommendedConnectionMethod(
        gmail.methods.filter(
          (candidate) =>
            candidate.capabilityProfile?.key === "draft" &&
            candidate.ownershipModes.includes("customer"),
        ),
      )?.key,
    ).toBe("customer-draft-oauth");
  });
  it("explains Google Workspace Developer Preview enrollment before connection", () => {
    const googleWorkspaceMcpSlugs = [
      "gmail",
      "google-drive",
      "google-docs",
      "google-sheets",
      "google-slides",
      "google-calendar",
      "google-chat",
      "google-people",
      "google-workspace-search",
    ];
    for (const slug of googleWorkspaceMcpSlugs) {
      const prerequisite = APP_DEFINITIONS.find(
        (app) => app.slug === slug,
      )?.setupPrerequisite;
      expect(prerequisite?.actionUrl, slug).toBe(
        "https://developers.google.com/workspace/preview",
      );
      expect(prerequisite?.description, slug).toContain(
        "does not enable unrelated Paperclip customers",
      );
      expect(prerequisite?.steps?.join(" "), slug).toContain(
        "final project-registration email",
      );
    }
  });
  it("withholds unverified and reserved providers from the app store without deleting their definitions", () => {
    expect([...APP_STORE_HIDDEN_SLUGS].sort()).toEqual([
      "beehiiv",
      "bitly",
      "brex",
      "candid",
      "coda",
      "context7",
      "egnyte",
      "embat",
      "kernel",
      "local-falcon",
      "make",
      "manufact",
      "oreilly",
      "planetscale",
      "razorpay",
      "sanity",
      "similarweb",
      "ticket-tailor",
      "ticktick",
      "xero",
    ]);
    expect(APP_STORE_DEFINITIONS).toHaveLength(69);
    const connectableSlugs = new Set(
      CONNECTABLE_APP_DEFINITIONS.map((entry) => entry.slug),
    );
    const storeSlugs = new Set(
      APP_STORE_DEFINITIONS.map((entry) => entry.slug),
    );
    for (const slug of APP_STORE_HIDDEN_SLUGS) {
      expect(connectableSlugs.has(slug), slug).toBe(true);
      expect(storeSlugs.has(slug), slug).toBe(false);
    }
  });
  it("ships matching local artwork for every store-visible provider", () => {
    const uiPublic = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../ui/public",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(uiPublic, "brands/apps/manifest.json"), "utf8"),
    ) as {
      providers: Array<{
        slug: string;
        catalogVisible: boolean;
        localAsset: string;
        darkAsset?: string;
      }>;
    };
    const visible = manifest.providers.filter((entry) => entry.catalogVisible);
    expect(visible).toHaveLength(APP_STORE_DEFINITIONS.length);
    expect(new Set(visible.map((entry) => entry.slug))).toHaveProperty(
      "size",
      visible.length,
    );
    expect(new Set(APP_STORE_DEFINITIONS.map((entry) => entry.slug))).toEqual(
      new Set(visible.map((entry) => entry.slug)),
    );
    for (const app of APP_STORE_DEFINITIONS) {
      const provenance = visible.find((entry) => entry.slug === app.slug)!;
      expect(provenance).toBeTruthy();
      expect(provenance.localAsset).toBe(app.branding.logoUrl);
      expect(provenance.darkAsset).toBe(app.branding.darkLogoUrl);
      expect(provenance.localAsset).toMatch(/^\/brands\/apps\/.+\.(svg|png)$/);
      expect(provenance.localAsset).not.toContain("google.com/s2/favicons");
      const asset = fs.readFileSync(path.join(uiPublic, provenance.localAsset));
      if (provenance.localAsset.endsWith(".png")) {
        expect(asset.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(asset.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
        expect(asset.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
      } else {
        const svg = asset.toString("utf8");
        expect(svg.trimStart()).toMatch(/^(?:<\?xml[^?]*\?>\s*)?<svg\b/);
        expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=/i);
      }
      if (provenance.darkAsset)
        expect(fs.existsSync(path.join(uiPublic, provenance.darkAsset))).toBe(
          true,
        );
    }
  });
  it("keeps every researched self-serve candidate implemented while blocked providers stay absent", () => {
    const definitions = new Map(
      CONNECTABLE_APP_DEFINITIONS.map((entry) => [entry.slug, entry]),
    );
    for (const candidate of SELF_SERVE_MCP_CANDIDATES)
      expect(appSupportsCatalogSetup(definitions.get(candidate.slug))).toBe(
        true,
      );
    for (const blocked of BLOCKED_MCP_PROVIDERS)
      expect(definitions.has(blocked.slug)).toBe(false);
  });
  it("keeps all Google Workspace profiles aligned with their app, endpoint, scopes, ownership, risk, and write policy", () => {
    expect(GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS).toEqual(
      GOOGLE_WORKSPACE_PROFILE_EXPECTATIONS.map((entry) => entry.profile),
    );
    expect(Object.keys(GOOGLE_WORKSPACE_CONNECTOR_PROFILES)).toEqual([
      ...GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS,
    ]);
    for (const expected of GOOGLE_WORKSPACE_PROFILE_EXPECTATIONS) {
      expect(
        GOOGLE_WORKSPACE_CONNECTOR_PROFILES[expected.profile],
        expected.profile,
      ).toEqual({
        appSlug: expected.appSlug,
        serverUrl: expected.serverUrl,
        scopes: expected.scopes,
        writeTools: expected.writeTools,
      });
      const app = APP_DEFINITIONS.find(
        (candidate) => candidate.slug === expected.appSlug,
      );
      const managed = app?.methods.find(
        (method) => method.connectorProfile === expected.profile,
      );
      expect(managed, expected.profile).toMatchObject({
        auth: "oauth",
        oauthStrategy: "paperclip_cloud_connector",
        connectorProfile: expected.profile,
        capabilityProfile: { key: expected.capability },
        grantKinds: ["user", "organization"],
        ownershipModes: ["platform_shared"],
        defaults: {
          serverUrl: expected.serverUrl,
          scopesHint: expected.scopes,
        },
        riskTier: expected.riskTier,
      });
      expect(managed?.riskTier, `${expected.profile}:write-risk`).toBe(
        expected.writeTools.length > 0 ? "S4" : "S3",
      );
      const customer = app?.methods.find(
        (method) =>
          method.auth === "oauth" &&
          method.oauthStrategy === undefined &&
          method.capabilityProfile?.key === expected.capability,
      );
      expect(customer, `${expected.profile}:customer-fallback`).toMatchObject({
        grantKinds: ["user", "organization"],
        ownershipModes: ["customer"],
        defaults: {
          serverUrl: expected.serverUrl,
          scopesHint: expected.scopes,
        },
        riskTier: expected.riskTier,
      });
    }
  });
  it("configures Shopify's current UCP and compatibility MCP methods without OAuth", () => {
    const shopify = APP_DEFINITIONS.find((app) => app.slug === "shopify");
    expect(shopify?.methods.map((method) => method.key)).toEqual([
      "ucp-commerce",
      "storefront-mcp",
    ]);
    const ucp = shopify?.methods[0];
    const compatibility = shopify?.methods[1];
    expect(ucp).toMatchObject({
      auth: "none",
      defaults: {
        serverUrlTemplate: "https://{storeDomain}/api/ucp/mcp",
        toolArgumentDefaults: {
          meta: {
            "ucp-agent": {
              profile:
                "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json",
            },
          },
        },
      },
      tenantFields: [
        expect.objectContaining({ key: "storeDomain", required: true }),
      ],
    });
    expect(compatibility).toMatchObject({
      auth: "none",
      defaults: { serverUrlTemplate: "https://{storeDomain}/api/mcp" },
    });
    expect(
      resolveConnectionMethodServerUrl(ucp!, {
        storeDomain: "paperclip-demo.myshopify.com",
      }),
    ).toBe("https://paperclip-demo.myshopify.com/api/ucp/mcp");
    expect(
      resolveConnectionMethodServerUrl(compatibility!, {
        storeDomain: "paperclip-demo.myshopify.com",
      }),
    ).toBe("https://paperclip-demo.myshopify.com/api/mcp");
    expect(resolveConnectionMethodServerUrl(ucp!, {})).toBeNull();
    expect(shopify?.setupPrerequisite).toMatchObject({
      title: "Launch the storefront before connecting",
      actionUrl: "https://admin.shopify.com/",
    });
    expect(shopify?.setupPrerequisite?.steps?.join(" ")).toContain(
      "Storefront visibility to Public",
    );
  });
  it("offers PostHog OAuth and API-key methods with zero-config defaults and advanced narrowing", () => {
    const posthog = APP_DEFINITIONS.find((app) => app.slug === "posthog");
    expect(posthog?.methods.map((method) => method.key)).toEqual([
      "mcp-oauth",
      "mcp-api-key",
    ]);
    for (const method of posthog?.methods ?? []) {
      const projectField = method.tenantFields?.find(
        (field) => field.key === "projectId",
      );
      expect(method.riskTier).toBe("S3");
      expect(
        method.tenantFields?.find((field) => field.key === "readOnly"),
      ).toMatchObject({ defaultValue: false, advanced: true });
      expect(projectField).toMatchObject({
        advanced: true,
        transport: { location: "header", name: "x-posthog-project-id" },
      });
      expect(projectField?.required).not.toBe(true);
      expect(
        method.tenantFields
          ?.filter((field) => field.advanced)
          .map((field) => field.key),
      ).toEqual(["projectId", "readOnly", "features", "tools"]);
      expect(
        method.tenantFields?.find((field) => field.key === "mode"),
      ).toMatchObject({
        hidden: true,
        defaultValue: "tools",
        transport: { location: "query", name: "mode" },
      });
      expect(method.configRequirements).toBeUndefined();
      expect(method.requiredResourceFilters).toBeUndefined();
      expect(method.guidanceMd).toContain("optional advanced controls");
    }
  });
  it("connects Neon's hosted server with optional project pinning and read-only mode", () => {
    const neon = APP_DEFINITIONS.find((app) => app.slug === "neon")!;
    expect(neon).toMatchObject({
      name: "Neon",
      categories: ["data"],
      urlPatterns: ["https://mcp.neon.tech/*"],
      docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
      redirectConstraints: "https-or-loopback-http",
      branding: { logoUrl: "/brands/apps/neon.png" },
    });
    expect(neon.branding.darkLogoUrl).toBeUndefined();
    expect(APP_STORE_DEFINITIONS.some((app) => app.slug === "neon")).toBe(true);
    expect(neon.methods.map((candidate) => candidate.key)).toEqual([
      "mcp-oauth",
      "mcp-api-key",
    ]);
    const [oauth, apiKey] = neon.methods;
    expect(oauth).toMatchObject({
      auth: "oauth",
      ownershipModes: ["dcr"],
      riskTier: "S4",
      requiredResourceFilters: ["project"],
      defaults: {
        serverUrl: "https://mcp.neon.tech/mcp",
        scopesHint: ["read", "write"],
      },
    });
    expect(apiKey).toMatchObject({
      auth: "api_key",
      ownershipModes: ["customer"],
      riskTier: "S4",
      defaults: { serverUrl: "https://mcp.neon.tech/mcp" },
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
      consoleLinks: {
        keys: "https://console.neon.tech/app/settings/api-keys",
      },
    });
    expect(apiKey!.credentialFields).toEqual([
      expect.objectContaining({
        key: "authorization",
        type: "password",
        secret: true,
        required: true,
      }),
    ]);
    for (const method of neon.methods) {
      // Nothing is required on the default path: both narrowing controls are
      // optional and folded under Advanced, and the provider enforces them.
      expect(method.tenantFields?.map((field) => field.key)).toEqual([
        "projectId",
        "readOnly",
      ]);
      expect(method.tenantFields?.every((field) => field.advanced && !field.required)).toBe(true);
      expect(method.tenantFields?.[0]).toMatchObject({
        type: "text",
        validation: { pattern: "^[a-z0-9-]+$", maxLength: 64 },
        transport: { location: "query", name: "projectId" },
      });
      expect(method.tenantFields?.[1]).toMatchObject({
        type: "checkbox",
        defaultValue: false,
        transport: {
          location: "query",
          name: "readonly",
          format: "boolean",
          omitFalse: true,
        },
      });
      expect(method.warnings?.length).toBe(2);
    }
  });
  it("connects Superagent's hosted server with an organization API key only", () => {
    const superagent = APP_DEFINITIONS.find((app) => app.slug === "superagent")!;
    expect(superagent).toMatchObject({
      name: "Superagent",
      categories: ["developer"],
      urlPatterns: ["https://www.superagent.sh/*"],
      docsUrl: "https://www.superagent.sh/docs/mcp",
      branding: { logoUrl: "/brands/apps/superagent.png" },
    });
    // The hosted server publishes no OAuth authorization-server metadata, so
    // there is no browser sign-in method and no OAuth redirect constraint.
    expect(superagent.redirectConstraints).toBeUndefined();
    expect(superagent.branding.darkLogoUrl).toBeUndefined();
    expect(APP_STORE_DEFINITIONS.some((app) => app.slug === "superagent")).toBe(true);
    expect(superagent.methods).toHaveLength(1);
    const [apiKey] = superagent.methods;
    expect(apiKey).toMatchObject({
      key: "mcp-api-key",
      transport: "mcp_remote",
      auth: "api_key",
      ownershipModes: ["customer"],
      riskTier: "S4",
      // The bare superagent.sh domain redirects, and some clients drop POST
      // bodies on redirect, so the www host is pinned.
      defaults: { serverUrl: "https://www.superagent.sh/mcp" },
      keyPlacement: {
        location: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
      consoleLinks: {
        keys: "https://www.superagent.sh/app/settings#api-keys",
        docs: "https://www.superagent.sh/docs/mcp",
      },
    });
    expect(apiKey!.tenantFields ?? []).toEqual([]);
    expect(apiKey!.credentialFields).toEqual([
      expect.objectContaining({
        key: "authorization",
        type: "password",
        placeholder: "sk_live_...",
        secret: true,
        required: true,
      }),
    ]);
    expect(apiKey!.credentialFields?.[0]?.helperMd).toContain("not scoped");
    expect(apiKey!.warnings).toEqual([
      expect.stringContaining("consume organization credits"),
    ]);
  });
  it("requires only reviewed provider or safety-boundary configuration on the default path", () => {
    const required = APP_DEFINITIONS.flatMap((app) =>
      app.methods.flatMap((method) =>
        [...(method.tenantFields ?? []), ...(method.extensionFields ?? [])]
          .filter(
            (field) =>
              field.required && field.advanced !== true && !field.hidden,
          )
          .map((field) => `${app.slug}:${method.key}:${field.key}`),
      ),
    ).sort();
    expect(required).toEqual([
      "clickhouse:mcp-oauth:serviceId",
      "honcho:mcp-api-key:workspaceId",
      "shopify:storefront-mcp:storeDomain",
      "shopify:ucp-commerce:storeDomain",
      "supabase:mcp-api-key:projectRef",
      "supabase:mcp-oauth:projectRef",
    ]);
  });
  it("limits Vercel Connect setup to the reviewed pilot methods", () => {
    const reviewed = APP_DEFINITIONS.flatMap((app) =>
      app.methods.flatMap((method) =>
        method.credentialSources?.vercelConnect
          ? [
              {
                slug: app.slug,
                key: method.key,
                review: method.credentialSources.vercelConnect,
              },
            ]
          : [],
      ),
    );
    expect(reviewed.map(({ slug, key }) => `${slug}:${key}`).sort()).toEqual([
      "linear:mcp-oauth",
      "notion:mcp-oauth",
      "posthog:mcp-api-key",
      "posthog:mcp-oauth",
    ]);
    expect(
      reviewed.find(({ slug }) => slug === "linear")?.review,
    ).toMatchObject({
      services: ["linear"],
      principalModes: ["user"],
      scopes: ["read", "write"],
      header: { name: "Authorization", prefix: "Bearer " },
    });
    expect(
      reviewed.find(
        ({ slug, key }) => slug === "posthog" && key === "mcp-oauth",
      )?.review.services,
    ).toEqual(["posthog", "mcp.posthog.com/mcp"]);
    expect(
      reviewed.find(
        ({ slug, key }) => slug === "posthog" && key === "mcp-api-key",
      )?.review.principalModes,
    ).toEqual(["app"]);
    expect(
      APP_DEFINITIONS.find((app) => app.slug === "vercel")?.availability
        ?.available,
    ).toBe(false);
  });
  it("enforces method and field invariants", () => {
    for (const app of APP_DEFINITIONS)
      for (const method of app.methods) {
        if (
          method.auth === "api_key" &&
          (method.purpose ?? "tool") !== "channel"
        )
          expect(method.keyPlacement).toBeTruthy();
        if (method.auth === "oauth")
          expect(method.ownershipModes.length).toBeGreaterThan(0);
        for (const field of method.credentialFields ?? [])
          if (field.required && field.type !== "checkbox")
            expect(field.placeholder).toBeTruthy();
      }
  });
});


describe("Railway provider", () => {
  it("matches only the hosted endpoint and exposes one vault-backed OAuth method", () => {
    const app = APP_STORE_DEFINITIONS.find((entry) => entry.slug === "railway")!;
    expect(getAppDefinitionForUrl("https://mcp.railway.com")?.slug).toBe("railway");
    for (const url of ["https://mcp.railway.com/path", "https://mcp.railway.com.evil.test", "http://mcp.railway.com"]) expect(getAppDefinitionForUrl(url)?.slug).not.toBe("railway");
    expect(app.methods).toHaveLength(1);
    expect(app.methods[0]).toMatchObject({ key: "mcp-oauth", auth: "oauth", transport: "mcp_remote", ownershipModes: ["dcr", "customer"], riskTier: "S4", defaults: { serverUrl: "https://mcp.railway.com", scopesHint: ["openid", "offline_access", "workspace:member"], oauthAuthorizationParams: { prompt: "consent" } } });
    expect(JSON.stringify(app.methods)).toContain("Live Railway qualification is pending");
  });
});


describe("tool method permission review", () => {
  const audit = JSON.parse(fs.readFileSync(new URL("../../../doc/connections/tool-method-permission-reviews.json", import.meta.url), "utf8")) as {
    methods: { app: string; method: string; auth: string; policy: string; requestedScopes: string[]; providerDefaultReason?: string; supportedActions: string; evidence: string[]; reviewedAt: string }[];
  };
  const methods = APP_DEFINITIONS.flatMap((app) => app.methods
    .filter((method) => method.purpose !== "channel" && method.purpose !== "ai")
    .map((method) => ({ app, method })));
  it("requires an explicit review for every tool method, including documented scope omissions", () => {
    expect(new Set(audit.methods.map((review) => `${review.app}/${review.method}`)).size).toBe(audit.methods.length);
    expect(audit.methods).toHaveLength(methods.length);
    for (const { app, method } of methods) {
      const review = audit.methods.find((entry) => entry.app === app.slug && entry.method === method.key);
      expect(review, `${app.slug}/${method.key}`).toBeDefined();
      expect(review!.auth).toBe(method.auth);
      expect(review!.supportedActions.length).toBeGreaterThan(15);
      expect(review!.evidence.length).toBeGreaterThan(0);
      if (method.auth === "oauth") {
        expect(method.defaults?.scopesHint ?? []).toEqual(review!.requestedScopes);
        if (!review!.requestedScopes.length) {
          expect(review!.policy).toBe("provider-default");
          expect(review!.providerDefaultReason!.length).toBeGreaterThan(30);
        } else expect(review!.policy).toBe("explicit");
      }
    }
  });
  it("requests Airtable record, schema and comment writes, and Hugging Face repository/job actions", () => {
    expect(APP_DEFINITIONS.find((app) => app.slug === "airtable")!.methods[0]!.defaults!.scopesHint).toEqual([
      "data.records:read", "data.records:write", "schema.bases:read", "schema.bases:write",
      "data.recordComments:read", "data.recordComments:write", "workspacesAndBases:read",
    ]);
    expect(APP_DEFINITIONS.find((app) => app.slug === "hugging-face")!.methods[0]!.defaults!.scopesHint)
      .toEqual(["read-mcp", "read-repos", "contribute-repos", "jobs"]);
  });
});

it("validates native pool catalog entries without inventing an authentication method", () => {
  const entry = aiConnectionRouterAppDefinition("example.pool", { name: "AI connection pool", description: "Use saved connections" });
  expect(appDefinitionSchema.parse(entry)).toEqual(entry);
  expect(entry.methods).toEqual([]);
  expect(appDefinitionSchema.safeParse({ ...entry, aiConnectionRouter: undefined }).success).toBe(false);
  expect(appDefinitionSchema.safeParse({ ...entry, methods: APP_STORE_DEFINITIONS[0]!.methods }).success).toBe(false);
  expect(appDefinitionSchema.safeParse({ ...entry, categories: ["developer"] }).success).toBe(false);
});
