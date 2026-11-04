import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Routes, useNavigate, useParams } from "@/lib/router";
import { aiConnectionRouterAppDefinition, aiConnectionRouterSlug, getAppStoreDefinition, type AiConnectionList, type AiConnectionPool, type ToolApplication, type ToolConnection } from "@paperclipai/shared";
import { Browse } from "@/pages/apps/Browse";
import { AppsConnect } from "@/pages/apps/AppsConnect";
import { AppDetail } from "@/pages/apps/AppDetail";
import { AppDetailSidebar } from "@/components/AppConnectionSidebar";
import { BreadcrumbBar } from "@/components/BreadcrumbBar";

export type PoolConnectorScenario = "catalog" | "setup" | "manage" | "empty" | "unavailable" | "permission" | "conflict" | "usage" | "exhausted" | "unknown" | "revoked";
export interface PoolConnectorStoryProps { pluginKey?: string; descriptor?: { name: string; description: string }; scenario?: PoolConnectorScenario }
const companyId = "company-storybook";
const poolId = "10000000-0000-4000-8000-000000000001";
const date = new Date("2026-09-10T12:00:00Z");
export const poolStoryAccounts: AiConnectionList["connections"] = [
  { id: "30000000-0000-4000-8000-000000000001", grantId: "40000000-0000-4000-8000-000000000001", companyId, provider: "openai", method: "subscription", name: "My ChatGPT account", ownership: "personal", isDefault: true, status: "connected" },
  { id: "30000000-0000-4000-8000-000000000002", grantId: "40000000-0000-4000-8000-000000000002", companyId, provider: "anthropic", method: "subscription", name: "My Claude account", ownership: "personal", isDefault: true, status: "connected" },
  { id: "30000000-0000-4000-8000-000000000003", grantId: "40000000-0000-4000-8000-000000000003", companyId, provider: "openrouter", method: "api_key", name: "Team OpenRouter", ownership: "shared", isDefault: true, status: "connected" },
];
/** Production Connectors routes with fixture data only. Used by host and plugin stories. */
export function ConnectionPoolConnectorHost({ pluginKey = "example.pool-router", descriptor = { name: "AI connection pool", description: "Rotate tasks between your AI connections." }, scenario = "catalog" }: PoolConnectorStoryProps) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } }));
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const previous = window.fetch;
    const catalog = [aiConnectionRouterAppDefinition(pluginKey, descriptor, scenario === "unavailable" ? { available: false, reason: "Ask your instance operator to enable AI connection routing." } : { available: true }), ...["openai", "anthropic", "openrouter", "github"].map(slug => getAppStoreDefinition(slug)!)];
    let pools: AiConnectionPool[] = ["setup", "empty", "catalog", "unavailable"].includes(scenario) ? [] : [{ id: poolId, companyId, pluginKey, name: "Research accounts", enabled: false, mode: ["usage", "exhausted", "unknown"].includes(scenario) ? "usage_aware" : "round_robin", thresholdPercent: 90, revision: 1, members: poolStoryAccounts.slice(0, 2).map((account, index) => ({ id: `20000000-0000-4000-8000-00000000000${index + 1}`, binding: { mode: "delegated", provider: account.provider, method: account.method, connectionId: account.id, grantId: account.grantId }, profile: index === 0 ? { provider: "codex", model: "gpt-5.6-sol" } : { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } })) }];
    const accounts = scenario === "empty" ? [] : scenario === "revoked" ? poolStoryAccounts.slice(1) : poolStoryAccounts;
    const applications = (): ToolApplication[] => catalog.map(app => ({ id: `app-${app.slug}`, companyId, applicationKey: app.aiConnectionRouter ? `plugin:${pluginKey}:ai-router` : `app-gallery:${app.slug}`, name: app.name, description: app.description, type: app.aiConnectionRouter ? "paperclip_plugin" : "mcp_http", status: "active", pluginId: app.aiConnectionRouter ? "plugin-storybook" : null, ownerAgentId: null, ownerUserId: "dotta", metadata: { sourceTemplateKey: app.slug }, archivedAt: null, createdAt: date, updatedAt: date }));
    const connections = (): ToolConnection[] => [...accounts.map(account => ({ id: account.id, name: account.name, enabled: true, slug: account.provider, config: { sourceTemplateKey: account.provider, ai: { provider: account.provider, method: account.method }, aiIsolatedSubscription: true } })), ...pools.map(pool => ({ id: pool.id, name: pool.name, enabled: pool.enabled, slug: aiConnectionRouterSlug(pluginKey), config: { aiRouter: { pluginKey }, sourceTemplateKey: aiConnectionRouterSlug(pluginKey) } }))].map(row => ({ id: row.id, companyId, applicationId: `app-${row.slug}`, name: row.name, uid: row.id, connectionKind: "managed", ownership: "customer", connectionPurpose: "ai", transport: "runtime_auth", authKind: "none", credentialSource: "paperclip_vault", credentialPolicy: "per_user", status: "active", enabled: row.enabled, transportConfig: {}, config: row.config, credentialSecretRefs: [], healthStatus: "ok", healthCheckedAt: date, healthMessage: null, lastError: null, createdByAgentId: null, createdByUserId: "dotta", createdAt: date, updatedAt: date }));
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const path = new URL(request?.url ?? String(input), window.location.origin).pathname;
      const method = init?.method ?? request?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const reply = (value: unknown) => Response.json(value);
      if (path === `/api/companies/${companyId}/chat-endpoints`) return reply([]);
      if (path === `/api/companies/${companyId}/agents`) return reply(["setup", "empty", "catalog", "unavailable"].includes(scenario) ? [] : [
        { id: "50000000-0000-4000-8000-000000000001", companyId, name: "Researcher", status: "idle", runtimeConfig: { aiConnection: { mode: "router", connectionId: poolId } } },
        { id: "50000000-0000-4000-8000-000000000002", companyId, name: "Writer", status: "paused", runtimeConfig: { aiConnection: { mode: "router", connectionId: poolId } } },
        { id: "50000000-0000-4000-8000-000000000003", companyId, name: "Other pool agent", status: "idle", runtimeConfig: { aiConnection: { mode: "router", connectionId: "another-pool" } } },
        { id: "50000000-0000-4000-8000-000000000004", companyId, name: "Former researcher", status: "terminated", runtimeConfig: { aiConnection: { mode: "router", connectionId: poolId } } },
      ]);
      if (path === `/api/companies/${companyId}/user-directory`) return reply({ users: [{ principalId: "dotta", status: "active", user: { name: "Dotta", email: "dotta@example.test" } }] });
      if (path === `/api/companies/${companyId}/tools/apps/attention`) return reply({ apps: [] });
      if (path === `/api/companies/${companyId}/tools/gallery`) return reply({ apps: catalog, capabilities: { canCreateOrganizationGrant: true, canSetCompanyInstall: true } });
      if (path === `/api/companies/${companyId}/tools/applications`) return reply({ applications: applications() });
      if (path === `/api/companies/${companyId}/tools/connections`) return reply({ connections: connections() });
      if (path === `/api/companies/${companyId}/ai-connections`) return reply({ currentUserId: "dotta", canManageConnections: scenario !== "permission", connections: accounts });
      if (path === `/api/companies/${companyId}/ai-connection-pools`) {
        if (scenario === "permission") return Response.json({ error: "A connection manager is required" }, { status: 403 });
        if (method === "GET") return reply(pools);
        if (scenario === "conflict") return Response.json({ error: "Pool changed; reload before saving" }, { status: 409 });
        const previousPool = pools.find(pool => pool.id === body.id);
        if (body.id && (!previousPool || previousPool.revision !== body.expectedRevision)) return Response.json({ error: "Pool changed; reload before saving" }, { status: 409 });
        const saved = { ...body.config, id: body.id ?? poolId, companyId, pluginKey, revision: (previousPool?.revision ?? 0) + 1 };
        pools = [...pools.filter(pool => pool.id !== saved.id), saved]; return reply(saved);
      }
      if (path.endsWith("/inspection")) return reply(Object.fromEntries((pools[0]?.members ?? []).map((member, index) => {
        const percent = scenario === "exhausted" ? 100 : index === 0 ? 94 : 42;
        const observed = ["usage", "exhausted", "unknown"].includes(scenario);
        const checkedAt = new Date(Date.now() - 15000).toISOString();
        return [member.id, { reason: "Eligible if agent access permits", checkedAt: observed ? checkedAt : null,
          ...(observed ? { usage: { connectionId: member.binding.connectionId, grantId: member.binding.grantId, provider: member.binding.provider, method: member.binding.method, status: scenario === "unknown" ? "unsupported" : "ok", checkedAt, source: "fixture", planType: "subscription", overage: null, limits: scenario === "unknown" ? [] : [{ id: "subscription", label: "Subscription", scope: null, usedPercent: percent, remainingPercent: 100 - percent, windowDurationSeconds: 18000, resetsAt: new Date(Date.now() + 180000).toISOString(), used: null, limit: null, remaining: null, unit: null, limitReached: percent >= 100, allowed: percent < 100 }] } } : {}) }];
      })));
      if (method === "DELETE" && path.includes("/ai-connection-pools/")) { pools = pools.filter(pool => !path.endsWith(pool.id)); return reply({ ok: true }); }
      const connection = path.match(/^\/api\/tool-connections\/([^/]+)$/);
      if (connection) { const row = connections().find(row => row.id === connection[1]); if (method === "DELETE") pools = pools.filter(pool => pool.id !== connection[1]); return row ? reply(row) : Response.json({ error: "Connection not found" }, { status: 404 }); }
      // Fixtures never forward a mutation to a live instance.
      if (path.startsWith("/api/") && method !== "GET") return Response.json({ error: "This preview does not run live operations." }, { status: 400 });
      return previous(input, init);
    };
    navigate(["setup", "empty"].includes(scenario) ? `/PAP/apps/connect?source=${aiConnectionRouterSlug(pluginKey)}` : ["catalog", "unavailable"].includes(scenario) ? "/PAP/apps" : `/PAP/apps/${poolId}/permissions`, { replace: true });
    setReady(true);
    return () => { window.fetch = previous; client.clear(); };
  }, []);
  if (!ready) return <p>Loading connectors…</p>;
  return <QueryClientProvider client={client}><Routes>
    <Route path="/:companyPrefix/apps" element={<div className="mx-auto max-w-5xl p-6"><BreadcrumbBar /><div className="pt-6"><Browse renderAccountDetails={() => null} /></div></div>} />
    <Route path="/:companyPrefix/apps/connect" element={<div className="mx-auto max-w-5xl p-6"><BreadcrumbBar /><div className="pt-6"><AppsConnect /></div></div>} />
    <Route path="/:companyPrefix/apps/:connectionId/:tab" element={<PoolDetailRoute />} />
  </Routes></QueryClientProvider>;
}
function PoolDetailRoute() {
  const { connectionId = "" } = useParams<{ connectionId: string }>();
  return <div className="flex min-h-screen"><div className="hidden w-56 shrink-0 md:block"><AppDetailSidebar kind="connection" connectionId={connectionId} /></div><main className="min-w-0 flex-1 p-6"><BreadcrumbBar /><div className="mx-auto max-w-3xl pt-6"><AppDetail /></div></main></div>;
}
