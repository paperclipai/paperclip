import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AiConnectionUsage,
  AiConnectionUsageLimit,
  AiManagedConnectionSummary,
  ConnectionGrantsResponse,
  ToolConnection,
} from "@paperclipai/shared";
import { ManagedAiConnectionDetails } from "@/components/ai-connections/ManagedAiConnectionDetails";

const companyId = "company-storybook";
const currentUserId = "usage-review-user";
const checkedAt = "2026-10-02T15:00:00Z";
const date = new Date(checkedAt);

function account(provider: AiManagedConnectionSummary["provider"], name: string): AiManagedConnectionSummary {
  return {
    id: `usage-review-${provider}`, grantId: `usage-grant-${provider}`, companyId,
    provider, method: provider === "openrouter" ? "api_key" : "subscription", name,
    accountLabel: "alex@example.test", ownership: "personal", ownerUserId: currentUserId,
    ownerName: "Alex", isDefault: true, status: "connected",
  };
}

function limit(id: string, label: string, usedPercent: number | null, overrides: Partial<AiConnectionUsageLimit> = {}): AiConnectionUsageLimit {
  return {
    id, label, scope: null, windowDurationSeconds: null, resetsAt: null,
    usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    used: null, limit: null, remaining: null, unit: "percent",
    limitReached: usedPercent === null ? null : usedPercent >= 100, allowed: null,
    ...overrides,
  };
}

interface Scenario {
  account: AiManagedConnectionSummary;
  usage: AiConnectionUsage;
  /** Keep the request pending so the loading state can be inspected. */
  pending?: boolean;
}

function scenario(provider: AiManagedConnectionSummary["provider"], name: string, usage: Partial<AiConnectionUsage>): Scenario {
  const row = account(provider, name);
  return {
    account: row,
    usage: {
      connectionId: row.id, grantId: row.grantId, provider, method: row.method,
      status: "ok", checkedAt, source: null, planType: null, limits: [], overage: null,
      ...usage,
    },
  };
}

const codex = scenario("openai", "My ChatGPT subscription", {
  planType: "pro",
  limits: [
    limit("primary", "5 hour limit", 62, { windowDurationSeconds: 18_000, resetsAt: "2026-10-02T18:00:00Z" }),
    limit("secondary", "Weekly limit", 100, { windowDurationSeconds: 604_800, resetsAt: "2026-10-05T15:00:00Z", allowed: false }),
  ],
  overage: { enabled: true, available: true, unlimited: false, used: null, limit: null, remaining: null, balance: 12.5, unit: "credits" },
});

const claude = scenario("anthropic", "My Claude subscription", {
  planType: "max",
  limits: [
    limit("five_hour", "5 hour limit", 38, { windowDurationSeconds: 18_000, resetsAt: "2026-10-02T19:00:00Z" }),
    limit("seven_day", "Weekly limit", 76, { windowDurationSeconds: 604_800, resetsAt: "2026-10-06T15:00:00Z" }),
    limit("weekly_code", "Weekly limit (group:code)", 100, {
      scope: "group:code", windowDurationSeconds: 604_800, resetsAt: "2026-10-06T15:00:00Z",
    }),
  ],
  overage: { enabled: true, available: true, unlimited: false, used: 7.5, limit: 50, remaining: 42.5, balance: null, unit: "USD" },
});

// The live billing response omitted included consumption: missing remains unknown.
const grok = scenario("xai", "My Grok subscription", {
  planType: "SuperGrok",
  limits: [
    limit("included", "Included plan", null, { unit: null, resetsAt: "2026-10-07T12:59:00Z" }),
    limit("on_demand", "On-demand spending", null, {
      used: 0, limit: 0, remaining: 0, unit: "USD", limitReached: true, resetInterval: "monthly",
    }),
  ],
  overage: { enabled: false, available: false, unlimited: false, used: 0, limit: 0, remaining: 0, balance: 0, unit: "USD" },
});

const openRouter = scenario("openrouter", "OpenRouter research key", {
  limits: [limit("key_limit", "API key spending limit", 75, {
    used: 75, limit: 100, remaining: 25, unit: "USD", resetInterval: "monthly",
  })],
});

const unavailable: Scenario = {
  ...claude,
  usage: { ...claude.usage, status: "error", limits: [], overage: null, errorCode: "permission_denied",
    message: "This credential does not have permission to read subscription usage." },
};

function connection(row: AiManagedConnectionSummary): ToolConnection {
  return {
    id: row.id, companyId, applicationId: `app-${row.provider}`, name: row.name, uid: row.id,
    connectionKind: "managed", ownership: "customer", connectionPurpose: "ai", transport: "runtime_auth",
    authKind: row.method === "subscription" ? "oauth" : "api_key", credentialSource: "paperclip_vault",
    credentialPolicy: "per_user", status: "active", enabled: true, transportConfig: {},
    config: { ai: { provider: row.provider, method: row.method }, aiIsolatedSubscription: true }, credentialSecretRefs: [],
    healthStatus: "ok", healthCheckedAt: date, healthMessage: null, lastError: null,
    createdByAgentId: null, createdByUserId: currentUserId, createdAt: date, updatedAt: date,
  };
}

function grants(row: AiManagedConnectionSummary): ConnectionGrantsResponse {
  return {
    connection: { id: row.id, uid: row.id }, currentUserId,
    members: [{ userId: currentUserId, name: "Alex", email: "alex@example.test" }],
    capabilities: {
      canConfigure: true, canCreateOrganizationGrant: true, canSetCompanyInstall: true,
      canConnectAsCurrentUser: true, canManageAgentInstalls: true,
      canViewOtherPersonalIdentities: true, editableAgentIds: [],
    },
    grants: [{
      id: row.grantId, companyId, connectionId: row.id, kind: "user", subjectUserId: currentUserId,
      providerTenant: { name: row.accountLabel }, credentialSecretRefs: [], status: "active", isDefault: false,
      createdByAgentId: null, createdByUserId: currentUserId, revokedAt: null, revokedByAgentId: null,
      revokedByUserId: null, lastUsedAt: null, createdAt: date, updatedAt: date, members: [],
      capabilities: { canRevoke: true, canEditAudience: false },
    }],
  };
}

/** Production account details; only HTTP responses are deterministic fixtures. */
export function AiConnectionUsageReview({ scenarios }: { scenarios: Scenario[] }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false },
  } }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      const path = url.pathname;
      if (path === `/api/companies/${companyId}/ai-connections`) {
        return Response.json({ currentUserId, canManageConnections: true, connections: scenarios.map((entry) => entry.account) });
      }
      for (const entry of scenarios) {
        const base = `/api/companies/${companyId}/ai-connections/${entry.account.id}`;
        if (path === `${base}/usage`) {
          if (entry.pending) return new Promise<Response>(() => {});
          return Response.json(entry.usage);
        }
        if (path === `${base}/active-runs`) return Response.json([]);
        if (path === `/api/tool-connections/${entry.account.id}/grants`) return Response.json(grants(entry.account));
      }
      // Fixture account controls cannot send mutations to a live instance.
      if (path.startsWith(`/api/companies/${companyId}/ai-connections`) || path.startsWith("/api/tool-connections/usage-review-")) {
        return Response.json({ error: "This Storybook preview only simulates usage checks." }, { status: 400 });
      }
      return previous(input, init);
    };
    window.fetch = fixtureFetch;
    setReady(true);
    return () => { if (window.fetch === fixtureFetch) window.fetch = previous; client.clear(); };
  }, [client, scenarios]);
  if (!ready) return <p className="p-6">Loading account details…</p>;
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto max-w-4xl space-y-6 p-6">
        <div className={scenarios.length > 1 ? "grid gap-6 md:grid-cols-2" : "max-w-2xl"}>
          {scenarios.map(({ account: row }) => (
            <section key={row.id} className="space-y-4 rounded-lg border border-border p-4" aria-label={row.name}>
              <h2 className="text-lg font-semibold">{row.name}</h2>
              <ManagedAiConnectionDetails connection={connection(row)} />
            </section>
          ))}
        </div>
      </main>
    </QueryClientProvider>
  );
}
export const USAGE_REVIEW_SCENARIOS = { codex, claude, grok, openRouter, unavailable };
