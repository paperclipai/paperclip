import { getConnectableAppDefinition, instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents } from "./paperclipData";
import inventory from "../../../doc/connections/memory-tool-inventory.json";

export const GUIDANCE_COMPANY = "company-storybook";
export const GUIDANCE_CONNECTION = "connection-guidance-preview";
export const guidanceAgents = storybookAgents.slice(0, 2).map((agent, i) => ({ ...agent, name: i ? "Morgan" : "Ada" }));

/** All connector requests remain in the story, including mutations from the real pages. */
export function installConnectionGuidanceFixtures(client: QueryClient, provider: "Honcho" | "Notion", options: { setup: boolean; askFirst: boolean }) {
  const company = GUIDANCE_COMPANY;
  const id = GUIDANCE_CONNECTION;
  const app = getConnectableAppDefinition(provider.toLowerCase())!;
  const timestamp = "2026-10-04T12:00:00.000Z";
  let connected = !options.setup;
  const connection = {
    id, uid: id, companyId: company, applicationId: "guidance-app", name: provider,
    connectionPurpose: "tool", credentialPolicy: "shared", transport: "mcp_remote",
    authKind: provider === "Honcho" ? "api_key" : "oauth", status: "active", enabled: true,
    healthStatus: "ok", healthMessage: null, requiresReauthorization: false,
    createdByUserId: "user-storybook", createdByAgentId: null,
    config: { sourceTemplateKey: app.slug, connectionMethodKey: app.methods[0]?.key, url: app.methods[0]?.defaults?.serverUrl },
    createdAt: timestamp, updatedAt: timestamp,
  };
  const application = { id: "guidance-app", companyId: company, applicationKey: app.slug, name: app.name, status: "active", metadata: { sourceTemplateKey: app.slug } };
  const observed = provider === "Honcho" ? inventory.providers.find(p => p.provider === "honcho")!.tools : [
    { name: "search", risk: "read", parameters: ["query"] },
    { name: "fetch", risk: "read", parameters: ["id"] },
    { name: "create_page", risk: "write", parameters: [] },
  ];
  const catalog = observed.map(tool => ({
    id: `guidance-${tool.name}`, companyId: company, applicationId: application.id, connectionId: id,
    entryKind: "tool", toolName: tool.name, title: tool.name.replaceAll("_", " "), description: `${provider} · ${tool.name}`,
    inputSchema: { type: "object", properties: {} }, outputSchema: null, annotations: null,
    riskLevel: tool.risk, isReadOnly: tool.risk === "read", isWrite: tool.risk === "write", isDestructive: tool.risk === "destructive",
    status: "active", version: null, schemaHash: "storybook", addedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  }));
  const capabilities = { canConfigure: true, canCreateOrganizationGrant: true, canSetCompanyInstall: true, canConnectAsCurrentUser: true, canManageAgentInstalls: true, canViewOtherPersonalIdentities: true };
  let profile = { profileKey: `app:${id}`, entries: catalog.map(entry => ({ effect: "include", catalogEntryId: entry.id })), bindings: guidanceAgents.map(agent => ({ targetType: "agent", targetId: agent.id })) };
  let policies = options.askFirst ? catalog.filter(t => !t.isReadOnly).map(t => ({ policyType: "require_approval", enabled: true, config: { source: "app_gallery_finish", connectionId: id, catalogEntryId: t.id } })) : [];
  let installs: Array<{ targetType: string; targetId: string }> = [];
  const grants = { connection: { id, uid: id }, capabilities, currentUserId: "user-storybook", members: [], grants: [{
    id: "guidance-grant", companyId: company, connectionId: id, kind: "organization", subjectUserId: null, subjectAgentId: null,
    status: "active", isDefault: true, providerTenant: { name: "Acme" }, members: [], capabilities: { canRevoke: true, canEditAudience: true },
    createdAt: timestamp, updatedAt: timestamp, credentialSecretRefs: [],
  }] };
  const gallery = { apps: [app], capabilities };
  const settings = { ...instanceExperimentalSettingsSchema.parse({}), enableMemoryConnectors: true };
  client.setQueryData(queryKeys.instance.experimentalSettings, settings);
  const responses = new Map<string, () => unknown>([
    [`/api/companies/${company}/agents`, () => guidanceAgents],
    [`/api/companies/${company}/tools/gallery`, () => gallery],
    [`/api/companies/${company}/tools/connections`, () => ({ connections: connected ? [connection] : [] })],
    [`/api/companies/${company}/tools/applications`, () => ({ applications: connected ? [application] : [] })],
    [`/api/tool-connections/${id}`, () => connection],
    [`/api/tool-connections/${id}/catalog`, () => ({ catalog })],
    [`/api/tool-connections/${id}/grants`, () => grants],
    [`/api/tool-connections/${id}/installs`, () => ({ connectionId: id, installs })],
    [`/api/companies/${company}/tools/profiles`, () => ({ profiles: [profile] })],
    [`/api/companies/${company}/tools/policies`, () => ({ policies })],
  ]);
  const seeds: Array<[readonly unknown[], unknown]> = [
    [queryKeys.agents.list(company), guidanceAgents], [queryKeys.apps.gallery(company), gallery],
    [queryKeys.tools.connection(id), connection], [queryKeys.tools.catalog(id), { catalog }],
    [queryKeys.tools.connectionGrants(id), grants], [queryKeys.tools.connectionInstalls(id), { connectionId: id, installs }],
    [queryKeys.tools.connections(company), { connections: connected ? [connection] : [] }],
    [queryKeys.tools.applications(company), { applications: connected ? [application] : [] }],
    [queryKeys.tools.profiles(company), { profiles: [profile] }], [queryKeys.tools.policies(company), { policies }],
  ];
  for (const [key, value] of seeds) client.setQueryData(key, value);
  const original = window.fetch;
  const fixture: typeof window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const path = url.pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = () => JSON.parse(String(init?.body ?? "{}"));
    if (path === "/api/instance/settings/experimental") return Response.json(settings);
    if (path === `/api/companies/${company}/tools/apps/connect`) {
      connected = true;
      return Response.json({ connectionId: id, connection, application, catalog,
        actions: { readOnly: catalog.filter(t => t.isReadOnly), canMakeChanges: catalog.filter(t => !t.isReadOnly) }, suggestedDefaults: {}, auth: null });
    }
    if (path.endsWith(`/apps/${id}/finish`)) {
      const next = body();
      profile = { ...profile, entries: (next.enabledCatalogEntryIds ?? []).map((catalogEntryId: string) => ({ effect: "include", catalogEntryId })),
        bindings: next.access === "all_agents" ? [{ targetType: "company", targetId: company }] : (next.access?.agentIds ?? []).map((targetId: string) => ({ targetType: "agent", targetId })) };
      policies = (next.askFirstCatalogEntryIds ?? []).map((catalogEntryId: string) => ({ policyType: "require_approval", enabled: true, config: { source: "app_gallery_finish", connectionId: id, catalogEntryId } }));
      return Response.json({ connectionId: id, installs });
    }
    if (path === `/api/tool-connections/${id}/installs` && method === "PUT") installs = body().installs ?? [];
    if (path === `/api/tool-connections/${id}` && method === "PATCH") {
      Object.assign(connection, body());
      return Response.json(connection);
    }
    if (method === "GET" && responses.has(path)) return Response.json(responses.get(path)!());
    if (path.endsWith("/preflight")) return Response.json({ oauth: { metadataFound: true, registrationAdvertised: true }, endpointReachable: true });
    if (path.includes(`/tool-connections/${id}/`) || path.includes(`/tools/apps/${id}/`)) {
      if (path.endsWith("/catalog/refresh")) return Response.json({ catalog, discoveredCount: catalog.length, quarantinedCount: 0 });
      if (path.endsWith("/test-agents")) return Response.json({ agents: guidanceAgents });
      // Unimplemented test/credential operations must not claim a real provider result.
      if (path.includes("test-")) return Response.json({ error: "Provider execution is not included in this design preview." }, { status: 422 });
      return Response.json({ connectionId: id, installs });
    }
    if (path.startsWith("/api/tools/oauth/")) return Response.json({ error: "Sign-in is not available in this design preview. No provider was contacted." }, { status: 422 });
    return original(input, init);
  };
  window.fetch = fixture;
  return () => { if (window.fetch === fixture) window.fetch = original; };
}
