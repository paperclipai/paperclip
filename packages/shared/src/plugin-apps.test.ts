import { afterEach, describe, expect, it } from "vitest";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import {
  getAppStoreDefinition,
  getConnectableAppDefinition,
  isConnectableAppSlug,
  setPluginAppDefinitions,
} from "./app-definitions.js";
import { getAppDefinitionForApplicationKey } from "./connector-identity.js";
import {
  isPluginAppSlug,
  parsePluginAppSlug,
  pluginAppDefinition,
  pluginAppSlug,
  reviewedToolRisk,
} from "./plugin-apps.js";
import { PLUGIN_CONNECTOR_TOOL_TIMEOUT_MAX_MS, PLUGIN_CONNECTOR_TOOL_TIMEOUT_MIN_MS, type AppDefinition } from "./types/app-definition.js";
import { appDefinitionSchema } from "./validators/app-definition.js";
import { pluginManifestV1Schema } from "./validators/plugin.js";

const circleback = APP_DEFINITIONS.find((app) => app.slug === "circleback") as AppDefinition;
const manifest = {
  id: "example.meetings",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Meetings",
  description: "Meeting connectors",
  author: "Tests",
  categories: ["connector"],
  capabilities: ["connectors.provide"],
  entrypoints: { worker: "worker.js" },
  apps: [structuredClone(circleback)],
};

afterEach(() => setPluginAppDefinitions([]));

describe("plugin app manifests", () => {
  it("accepts apps that use the built-in app-definition schema with connectors.provide", () => {
    const parsed = pluginManifestV1Schema.parse(manifest);
    expect(parsed.apps?.[0]).toMatchObject({ slug: "circleback", name: "Circleback" });
  });

  it("requires connectors.provide for apps", () => {
    const result = pluginManifestV1Schema.safeParse({ ...manifest, capabilities: ["agent.tools.register"] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("connectors.provide");
  });

  it("rejects duplicate slugs within one plugin", () => {
    const result = pluginManifestV1Schema.safeParse({ ...manifest, apps: [circleback, circleback] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("Duplicate app slug");
  });

  it("validates each app with the built-in app-definition schema", () => {
    const { methods: _methods, ...withoutMethods } = circleback;
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [withoutMethods] }).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [{ ...circleback, slug: "Not A Slug" }] }).success).toBe(false);
  });

  it.each(["plugin", "aiConnectionRouter", "experimentalFeatureKey", "availability"])("rejects host-derived field %s", (field) => {
    const values: Record<string, unknown> = {
      plugin: { pluginKey: "other.plugin", appSlug: "circleback" },
      aiConnectionRouter: { pluginKey: "example.meetings" },
      experimentalFeatureKey: "enableMemoryConnectors",
      availability: { available: true },
    };
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [{ ...circleback, [field]: values[field] }] }).success).toBe(false);
  });

  it("limits plugin app methods to tool transports a definition can fully describe", () => {
    const method = circleback.methods[0]!;
    for (const changed of [
      { ...method, transport: "rest_api" },
      { ...method, transport: "chat_sdk" },
      { ...method, purpose: "channel" },
      { ...method, provider: "slack" },
    ]) {
      expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [{ ...circleback, methods: [changed] }] }).success).toBe(false);
    }
  });
});

describe("plugin app credentials", () => {
  const asana = APP_DEFINITIONS.find((app) => app.slug === "asana") as AppDefinition;
  const managed = asana.methods.find((method) => method.oauthStrategy === "paperclip_cloud_connector")!;

  it("allows a managed OAuth profile only with the built-in connector's endpoint", () => {
    const copy = { ...structuredClone(asana), methods: [structuredClone(managed)] };
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [copy] }).success).toBe(true);
    const redirected = structuredClone(copy);
    redirected.methods[0]!.defaults = { ...redirected.methods[0]!.defaults, serverUrl: "https://plugin.example.test/mcp" };
    const result = pluginManifestV1Schema.safeParse({ ...manifest, apps: [redirected] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("managed OAuth profile");
  });

  it("rejects Vercel Connect credentials in plugin apps", () => {
    const vercel = APP_DEFINITIONS.flatMap((app) => app.methods).find((method) => method.credentialSources?.vercelConnect);
    expect(vercel).toBeTruthy();
    const app = { ...structuredClone(circleback), methods: [{ ...structuredClone(circleback.methods[0]!), auth: "api_key", ownershipModes: ["customer"],
      keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " }, credentialSources: vercel!.credentialSources }] };
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [app] }).success).toBe(false);
  });

  it("rejects a plugin id and slug too long for the connect API", () => {
    expect(pluginManifestV1Schema.safeParse({ ...manifest, id: `a${"b".repeat(150)}` }).success).toBe(false);
  });
});

describe("plugin connector settings schemas", () => {
  const method = (settingsSchema: Record<string, unknown>) => ({
    key: "default", transport: "plugin", auth: "none", ownershipModes: ["customer"], whenToUse: "Use", guidanceMd: "Use", riskTier: "S1",
    settingsSchema, tools: { kind: "static", list: [{ name: "lookup", risk: "read", parametersSchema: { type: "object" } }] },
  });
  const app = (settingsSchema: Record<string, unknown>) => ({ ...structuredClone(circleback), methods: [method(settingsSchema)] });

  it("accepts a flat object of simple fields the board can render", () => {
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [app({ type: "object", properties: {
      region: { type: "string", enum: ["us", "eu"], title: "Region" }, limit: { type: "integer", minimum: 1 }, verbose: { type: "boolean" },
    }, required: ["region"], additionalProperties: false })] }).success).toBe(true);
  });

  it.each([
    { type: "object", properties: { nested: { type: "object", properties: {} } } },
    { type: "object", properties: { linked: { $ref: "#/definitions/x" } } },
    { type: "object", allOf: [] },
    { type: "array" },
    { type: "object", properties: { a: { type: "string" } }, required: ["missing"] },
    { type: "object", properties: { flag: { type: "boolean", enum: [true, false] } } },
    { type: "object", properties: { token: { type: "string", format: "secret-ref" } } },
  ])("rejects settings the board cannot render: %j", (settingsSchema) => {
    expect(pluginManifestV1Schema.safeParse({ ...manifest, apps: [app(settingsSchema)] }).success).toBe(false);
  });
});

describe("plugin connector tool timeouts", () => {
  const pluginMethod = (extra: { timeoutMs?: unknown; toolTimeoutMs?: unknown }) => ({
    key: "default", transport: "plugin", auth: "none", ownershipModes: ["customer"], whenToUse: "Use", guidanceMd: "Use", riskTier: "S1",
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    tools: { kind: "static", list: [{ name: "lookup", risk: "read", parametersSchema: { type: "object" },
      ...(extra.toolTimeoutMs !== undefined ? { timeoutMs: extra.toolTimeoutMs } : {}) }] },
  });
  const parse = (methodDef: Record<string, unknown>) =>
    pluginManifestV1Schema.safeParse({ ...manifest, apps: [{ ...structuredClone(circleback), methods: [methodDef] }] }).success;

  it("accepts method and tool timeouts from 1 s to the 60 s gateway ceiling", () => {
    expect(parse(pluginMethod({ timeoutMs: 30_000, toolTimeoutMs: 45_000 }))).toBe(true);
    expect(parse(pluginMethod({ timeoutMs: PLUGIN_CONNECTOR_TOOL_TIMEOUT_MIN_MS, toolTimeoutMs: PLUGIN_CONNECTOR_TOOL_TIMEOUT_MAX_MS }))).toBe(true);
  });

  it.each([
    { timeoutMs: PLUGIN_CONNECTOR_TOOL_TIMEOUT_MAX_MS + 1 },
    { timeoutMs: 999 },
    { timeoutMs: 1_500.5 },
    { timeoutMs: "30000" },
    { toolTimeoutMs: 120_000 },
    { toolTimeoutMs: 0 },
  ])("rejects a timeout outside the gateway's range: %j", (extra) => {
    expect(parse(pluginMethod(extra))).toBe(false);
  });

  it("rejects timeoutMs on methods the plugin worker does not serve", () => {
    expect(parse({ ...structuredClone(circleback.methods[0]!), timeoutMs: 30_000 })).toBe(false);
  });
});

describe("plugin app slugs", () => {
  it("namespaces by plugin key and reads the owner back from the slug", () => {
    const slug = pluginAppSlug("example.meetings", "circleback");
    expect(slug).not.toBe("circleback");
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(parsePluginAppSlug(slug)).toEqual({ pluginKey: "example.meetings", appSlug: "circleback" });
    expect(isPluginAppSlug("circleback")).toBe(false);
    expect(isPluginAppSlug(pluginAppSlug("other_plugin-2", "a-b"))).toBe(true);
    expect(parsePluginAppSlug(`plugin-${"zz"}-x`)).toBeNull();
  });

  it("keeps a plugin copy of a built-in app separate from the built-in one", () => {
    const definition = pluginAppDefinition("example.meetings", circleback);
    expect(appDefinitionSchema.parse(definition)).toMatchObject({ plugin: { pluginKey: "example.meetings", appSlug: "circleback" } });
    expect(getConnectableAppDefinition(definition.slug)).toBeNull();

    setPluginAppDefinitions([definition]);
    expect(getConnectableAppDefinition(definition.slug)).toEqual(definition);
    expect(getAppStoreDefinition(definition.slug)).toEqual(definition);
    expect(isConnectableAppSlug(definition.slug)).toBe(true);
    expect(getAppDefinitionForApplicationKey(`app-gallery:${definition.slug}:00000000-0000-4000-8000-000000000000`)).toEqual(definition);
    // The built-in app is never shadowed.
    expect(getConnectableAppDefinition("circleback")).toBe(circleback);

    setPluginAppDefinitions([]);
    expect(getConnectableAppDefinition(definition.slug)).toBeNull();
  });
});

describe("reviewed tool risk", () => {
  const review = circleback.reviewedTools!;

  it("classifies Circleback's reviewed tools from its definition", () => {
    expect(reviewedToolRisk(review, { name: "SearchMeetings" })).toBe("read");
    expect(reviewedToolRisk(review, { name: "DisplayMeetings" })).toBe("read");
    // The generic classifier reads share and submit verbs as reads.
    expect(reviewedToolRisk(review, { name: "ShareMeeting" })).toBe("write");
    expect(reviewedToolRisk(review, { name: "SubmitFeedback" })).toBe("write");
    expect(reviewedToolRisk(review, { name: "DeleteFolder" })).toBe("destructive");
    expect(reviewedToolRisk(review, { name: "BrandNewTool" })).toBe("write");
  });

  it("lets provider hints raise risk but never lower it", () => {
    expect(reviewedToolRisk(review, { name: "SearchMeetings", annotations: { readOnlyHint: false } })).toBe("write");
    expect(reviewedToolRisk(review, { name: "SearchMeetings", annotations: { destructiveHint: true } })).toBe("destructive");
    expect(reviewedToolRisk(review, { name: "DeleteTag", annotations: { readOnlyHint: true } })).toBe("destructive");
    expect(reviewedToolRisk(review, { name: "ShareFolder", annotations: { readOnlyHint: true } })).toBe("write");
  });

  it("never lowers a destructive review because of a write hint", () => {
    const strict = { ...review, unlisted: "destructive" as const };
    expect(reviewedToolRisk(strict, { name: "BrandNewTool", annotations: { readOnlyHint: false } })).toBe("destructive");
    expect(reviewedToolRisk(strict, { name: "BrandNewTool", annotations: { writeHint: true } })).toBe("destructive");
  });

  it("rejects a tool listed at two risk levels", () => {
    expect(appDefinitionSchema.safeParse({ ...circleback, reviewedTools: { ...review, write: ["SearchMeetings"] } }).success).toBe(false);
  });
});
