import { BreadcrumbBar } from "@/components/BreadcrumbBar";
import { AiReviewBoundary } from "./AiReviewFrame";
import { AiConnectionAccountControls } from "@/components/ai-connections/AiConnectionAccountControls";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Routes, useNavigate, useSearchParams } from "@/lib/router";
import { APP_DEFINITIONS, getAppStoreDefinition, type AppDefinition, type ToolApplication, type ToolConnection, type ConnectionGrantsResponse } from "@paperclipai/shared";
import { Browse } from "@/pages/apps/Browse";
import { AppDetail } from "@/pages/apps/AppDetail";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AiConnectionAuth, type AiAuthState } from "@/components/ai-connections/AiConnectionAuth";
import { CredentialModeLink } from "@/components/onboarding/CredentialModeLink";
import { AI_PROVIDERS, aiMethodLabel, type AiConnectionSummary, type AiProvider, type AiAuthMethod } from "@/components/ai-connections/model";
import { AI_REVIEW_CONNECTIONS } from "../fixtures/aiConnections";
import { storybookAgents } from "../fixtures/paperclipData";

const companyId = "company-storybook";
const date = new Date("2026-09-10T12:00:00Z");
const agents = storybookAgents.slice(0, 2).map((agent, index) => ({ ...agent, id: index ? "atlas" : "nova", name: index ? "Atlas" : "Nova" }));
const capabilities = { canConfigure: true, canCreateOrganizationGrant: true, canSetCompanyInstall: true, canConnectAsCurrentUser: true, canManageAgentInstalls: true, canViewOtherPersonalIdentities: true, editableAgentIds: ["nova", "atlas"] };
const members = [{ userId: "dotta", name: "Dotta", email: "dotta@example.test" }, { userId: "sam", name: "Sam", email: "sam@example.test" }];

/** Use the production provider catalog; only accounts and actions are simulated. */
const gallery: AppDefinition[] = (Object.keys(AI_PROVIDERS) as AiProvider[]).map((provider) => getAppStoreDefinition(provider)!);
for (const slug of ["github", "gmail"]) {
  const app = getAppStoreDefinition(slug);
  if (app) gallery.push(app);
}
function asConnection(account: AiConnectionSummary): ToolConnection {
  return {
    id: account.id, companyId, applicationId: `app-${account.provider}`, name: account.name, uid: account.id,
    connectionKind: "managed", ownership: "customer", connectionPurpose: "ai", transport: "runtime_auth", authKind: account.method === "subscription" ? "oauth" : "api_key",
    credentialSource: "paperclip_vault", credentialPolicy: account.ownership === "shared" ? "shared" : "per_user",
    status: account.status === "revoked" ? "disabled" : "active", enabled: account.status !== "revoked",
    transportConfig: {}, config: { sourceTemplateKey: account.provider, ai: { provider: account.provider, method: account.method }, aiIsolatedSubscription: true }, credentialSecretRefs: [],
    healthStatus: account.status === "connected" ? "ok" : "error", healthCheckedAt: date,
    healthMessage: account.status === "connected" ? null : "Sign in again to restore this account. No other account will be used.",
    lastError: account.status === "connected" ? null : "This account needs to be connected again.",
    createdByAgentId: null, createdByUserId: account.ownerUserId ?? "dotta", createdAt: date, updatedAt: date,
  };
}
function grantsFor(account: AiConnectionSummary, readOnly: boolean): ConnectionGrantsResponse {
  return { connection: { id: account.id, uid: account.id }, currentUserId: "dotta", members,
    capabilities: Object.fromEntries(Object.entries(capabilities).map(([key, value]) => [key, typeof value === "boolean" ? !readOnly && value : value])) as typeof capabilities,
    grants: [{ id: account.grantId, companyId, connectionId: account.id,
      kind: account.ownership === "shared" ? "organization" : "user", subjectUserId: account.ownerUserId ?? null,
      providerTenant: { name: account.accountLabel ?? account.name }, credentialSecretRefs: [],
      status: account.status === "connected" ? "active" : account.status === "revoked" ? "revoked" : "expired",
      isDefault: account.ownership === "shared", createdByAgentId: null, createdByUserId: account.ownerUserId ?? "dotta",
      revokedAt: null, revokedByAgentId: null, revokedByUserId: null, lastUsedAt: null, createdAt: date, updatedAt: date,
      members: [], capabilities: { canRevoke: !readOnly && (account.ownership === "shared" || account.ownerUserId === "dotta"), canEditAudience: !readOnly && account.ownership === "shared" },
    }],
  };
}

/** Mount the production route components against an isolated, deterministic in-memory API. */
export function AiConnectorPages({ initialConnections = AI_REVIEW_CONNECTIONS, detail = false, readOnly = false }: {
  initialConnections?: AiConnectionSummary[]; detail?: boolean; readOnly?: boolean;
}) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false }, mutations: { retry: false } } }));
  const [store] = useState(() => ({ profiles: new Map<string, unknown>(initialConnections.filter((row) => row.id === "claude-dotta").map((row) => [row.id, {
    id: `profile-${row.id}`, companyId, profileKey: `app:${row.id}`, entries: [], bindings: ["nova"].map((targetId) => ({ targetType: "agent", targetId })),
  }])), accounts: initialConnections.map((row) => ({ ...row })), removed: new Set<string>(), installs: new Map<string, unknown[]>(), audience: new Map<string, string[]>() }));
  const [ready, setReady] = useState(false);
  const [, render] = useState(0);
  const navigate = useNavigate();
  function update(account: AiConnectionSummary) {
    store.accounts = store.accounts.some((row) => row.id === account.id) ? store.accounts.map((row) => row.id === account.id ? account : row) : [...store.accounts, account];
    void client.invalidateQueries(); render((n) => n + 1);
  }
  useEffect(() => {
    const previous = window.fetch;
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const path = url.pathname;
      const rows = store.accounts.filter((row) => !store.removed.has(row.id));
      const applications: ToolApplication[] = gallery.map((app) => ({ id: `app-${app.slug}`, companyId, applicationKey: `app-gallery:${app.slug}:review`, name: app.name, description: app.description, type: "mcp_http", status: "active", pluginId: null, ownerAgentId: null, ownerUserId: "dotta", metadata: { sourceTemplateKey: app.slug }, archivedAt: null, createdAt: date, updatedAt: date }));
      const reply = (value: unknown) => Promise.resolve(Response.json(value));
      if (path === `/api/companies/${companyId}/tools/gallery`) return reply({ apps: gallery, capabilities: { canCreateOrganizationGrant: !readOnly, organizationGrantReason: null, canSetCompanyInstall: !readOnly, companyInstallReason: null } });
      if (path === `/api/companies/${companyId}/tools/applications`) return reply({ applications });
      if (path === `/api/companies/${companyId}/tools/connections`) return reply({ connections: rows.map(asConnection) });
      if (path === `/api/companies/${companyId}/tools/profiles`) return reply({ profiles: [...store.profiles.values()] });
      if (path === `/api/companies/${companyId}/tools/policies`) return reply({ policies: [] });
      if (path === `/api/companies/${companyId}/agents`) return reply(agents);
      if (path === `/api/companies/${companyId}/user-directory`) return reply({ users: members.map((member) => ({ principalId: member.userId, status: "active", user: { name: member.name, email: member.email } })) });
      const match = path.match(/^\/api\/tool-connections\/([^/]+)(.*)$/);
      if (match) {
        const row = store.accounts.find((candidate) => candidate.id === match[1]);
        if (!row) return Response.json({ error: "Unknown review connection" }, { status: 404 });
        const suffix = match[2];
        if (!suffix) {
          if (method === "PATCH") update({ ...row, name: payload.name ?? row.name });
          if (method === "DELETE") store.removed.add(row.id);
          return reply(asConnection(store.accounts.find((candidate) => candidate.id === row.id)!));
        }
        if (suffix === "/grants") {
          const result = grantsFor(row, readOnly);
          result.grants[0].members = (store.audience.get(row.id) ?? []).map((userId) => ({ id: `member-${userId}`, companyId, grantId: row.grantId, subjectType: "user" as const, subjectId: userId, createdAt: date }));
          return reply(result);
        }
        if (method === "DELETE" && /^\/grants\/[^/]+$/.test(suffix)) { update({ ...row, status: "revoked" }); return reply(grantsFor({ ...row, status: "revoked" }, readOnly).grants[0]); }
        if (suffix.endsWith("/members")) { store.audience.set(row.id, payload.memberUserIds ?? []); return reply(grantsFor(row, readOnly).grants[0]); }
        if (suffix === "/installs") {
          if (method === "PUT") store.installs.set(row.id, payload.installs ?? []);
          return reply({ connectionId: row.id, installs: store.installs.get(row.id) ?? [] });
        }
        if (suffix === "/catalog") return reply({ catalog: [] });
        return Response.json({ error: `Unsupported review operation: ${suffix}` }, { status: 400 });
      }
      if (path.startsWith(`/api/companies/${companyId}/tools/apps/`) && path.endsWith("/finish")) {
        const id = path.split("/").at(-2)!;
        const profile = { id: `profile-${id}`, companyId, profileKey: `app:${id}`, entries: [], bindings: payload.access === "all_agents" ? [{ targetType: "company", targetId: companyId }] : (payload.access?.agentIds ?? []).map((targetId: string) => ({ targetType: "agent", targetId })) };
        store.profiles.set(id, profile);
        return reply({ connection: asConnection(rows.find((row) => row.id === id)!), profile, policy: null });
      }
      // Unhandled fixture mutations must never reach a live API/provider.
      if (method !== "GET" && path.startsWith("/api/")) return Response.json({ error: "This review does not perform live operations." }, { status: 400 });
      return previous(input, init);
    };
    navigate(detail ? `/PAP/apps/${initialConnections[0]?.id ?? "claude-dotta"}/permissions` : "/PAP/apps", { replace: true });
    setReady(true);
    return () => { window.fetch = previous; client.clear(); };
  }, []);
  if (!ready) return <p className="p-6">Loading Connectors review…</p>;
  return <QueryClientProvider client={client}>
    <main className="mx-auto max-w-5xl p-6">
      <p className="mb-6 text-xs text-muted-foreground">Existing app page components below · Fixture accounts · Review annotation</p>
      <BreadcrumbBar />
      <div className="pt-6">
      <Routes>
        <Route path="/:companyPrefix/apps" element={<Browse renderAccountDetails={(connection) => {
          const row = store.accounts.find((account) => account.id === connection.id);
          return row ? <p className="text-xs text-muted-foreground">{aiMethodLabel(row.provider, row.method)} · {row.ownership === "shared" ? "Company shared" : "Personal"}{row.isDefault ? " · Personal default" : ""}{row.accountLabel ? ` · ${row.accountLabel}` : ""}</p> : null;
        }} />} />
        <Route path="/:companyPrefix/apps/connect" element={<Setup accounts={store.accounts} onSave={update} />} />
        <Route path="/:companyPrefix/apps/:connectionId/:tab" element={<AppDetail onReconnect={(connection) => navigate(`/apps/connect?source=${connection.config?.sourceTemplateKey}&stage=setup&reconnect=${connection.id}`)} renderActions={(connection) => {
          const account = store.accounts.find((row) => row.id === connection.id);
          return account ? <AiReviewBoundary label="App component: AI account controls inside existing AppDetail"><AiConnectionAccountControls account={account} currentUserId="dotta" grant={grantsFor(account, readOnly).grants[0]} readOnly={readOnly}
            onMakeDefault={() => {
              store.accounts = store.accounts.map((row) => row.provider === account.provider && row.method === account.method && row.ownerUserId === "dotta" ? { ...row, isDefault: row.id === account.id } : row); update({ ...account, isDefault: true });
            }}
            onReconnect={() => navigate(`/apps/connect?source=${account.provider}&stage=setup&reconnect=${account.id}`)}
            onRevoke={() => update({ ...account, status: "revoked" })}
            /></AiReviewBoundary> : undefined;
        }} />} />
      </Routes>
      </div>
    </main>
  </QueryClientProvider>;
}

function Setup({ accounts, onSave }: { accounts: AiConnectionSummary[]; onSave: (account: AiConnectionSummary) => void }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const provider = (params.get("source") ?? "anthropic") as AiProvider;
  const reconnect = accounts.find((row) => row.id === params.get("reconnect"));
  const [method, setMethod] = useState<AiAuthMethod>(reconnect?.method ?? (provider === "openrouter" ? "api_key" : "subscription"));
  const [state, setState] = useState<AiAuthState>({ phase: "idle" });
  const [name, setName] = useState(reconnect?.name ?? `My ${AI_PROVIDERS[provider]?.subscriptionName ?? "OpenRouter API"}`);
  const [savedId, setSavedId] = useState<string>();
  function complete(grantKind: string, agentIds: string[], allAgents: boolean) {
    const id = reconnect?.id ?? `review-${provider}-${accounts.length}`;
    const personal = reconnect ? reconnect.ownership === "personal" : grantKind === "user";
    onSave(reconnect ? { ...reconnect, status: "connected" } : { id, grantId: `grant-${id}`, companyId, provider, method, name, ownership: personal ? "personal" : "shared", ownerUserId: personal ? "dotta" : undefined, ownerName: personal ? "Dotta" : undefined, status: "connected", isDefault: personal && !accounts.some((row) => row.ownerUserId === "dotta" && row.provider === provider && row.method === method && row.isDefault) });
    if (!reconnect) void fetch(`/api/companies/${companyId}/tools/apps/${id}/finish`, { method: "POST", body: JSON.stringify({ access: allAgents ? "all_agents" : { agentIds } }) });
    setSavedId(id); setState({ phase: "connected" });
  }
  if (!(provider in AI_PROVIDERS)) return <><p className="text-sm">This review focuses on AI authentication. The existing connector remains in the same list.</p><Button onClick={() => navigate("/apps")}>Back to Connectors</Button></>;
  return <ConnectionSetupFlow serviceSlug={provider} onCancel={() => navigate("/apps")} renderCredentialStep={({ grantKind, agentIds, allAgents }) => <AiReviewBoundary label="Shared AI credential presentation · Existing setup shell and login cards"><div className="mx-auto max-w-xl space-y-4">
    <label className="block space-y-2 text-sm">Connection name<Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(reconnect)} /></label>
    {!reconnect && provider !== "openrouter" && <CredentialModeLink mode={method === "subscription" ? "subscription" : "api"} onChange={() => { setMethod(method === "subscription" ? "api_key" : "subscription"); setState({ phase: "idle" }); }} />}
    <AiConnectionAuth provider={provider} method={method} state={state}
      onStart={() => setState({ phase: "waiting", authorizationUrl: "https://example.test/review-authorization", code: provider === "openai" ? "REVIEW-CODE" : undefined })}
      onSubmit={() => complete(grantKind, agentIds, allAgents)}
      onCancel={() => navigate("/apps")}
      onDone={() => navigate(`/apps/${savedId}/permissions`)} />
    {state.phase === "waiting" && method === "subscription" && provider !== "anthropic" && <Button variant="outline" onClick={() => complete(grantKind, agentIds, allAgents)}>Storybook only: simulate browser completion</Button>}
  </div></AiReviewBoundary>} />;
}
