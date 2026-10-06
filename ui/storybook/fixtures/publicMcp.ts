import { instanceExperimentalSettingsSchema, type InstanceExperimentalSettingsWithManaged, type McpConnection, type McpConnectionRequest } from "@paperclipai/shared";
import { fn } from "storybook/test";

export const consentSubmission = fn();
export const request: McpConnectionRequest = {
  id: "storybook-request", clientName: "Codex", redirectOrigin: "https://chatgpt.com",
  requestedWrite: true, offlineAccess: true, requiresSignIn: false, requestedCompanyId: null,
  companies: [
    { id: "00000000-0000-4000-8000-000000000001", name: "Acme Research", logoUrl: null, canWrite: true },
    { id: "00000000-0000-4000-8000-000000000002", name: "Design Partners", logoUrl: null, canWrite: false },
  ], setupUrl: null,
};
const connections: McpConnection[] = [
  { id: "codex", companyId: request.companies[0].id, companyName: "Acme Research", clientName: "Codex", scopes: ["paperclip:read", "paperclip:write"], createdAt: "2020-01-01T00:00:00Z", revokedAt: null },
  { id: "claude", companyId: request.companies[1].id, companyName: "Design Partners", clientName: "Claude", scopes: ["paperclip:read"], createdAt: "2020-01-01T00:00:00Z", revokedAt: null },
];
export interface PublicMcpFixture {
  request?: Partial<McpConnectionRequest>;
  loading?: boolean;
  unavailable?: boolean;
  deviceExpired?: boolean;
  connectionsUnavailable?: boolean;
  pending?: boolean;
  mutationError?: boolean;
  empty?: boolean;
  connections?: McpConnection[];
  revoked?: boolean;
  enabled?: boolean;
  managed?: boolean;
}

/** Per-story state; every MCP mutation stays inside this preview. */
export function installPublicMcpFixture(fixture: PublicMcpFixture = {}) {
  consentSubmission.mockClear();
  const original = window.fetch;
  let rows = fixture.empty ? [] : (fixture.connections ?? connections).map(row => ({ ...row, revokedAt: fixture.revoked ? "2020-01-02T00:00:00Z" : null }));
  let settings: InstanceExperimentalSettingsWithManaged = { ...instanceExperimentalSettingsSchema.parse({}), enablePublicMcp: Boolean(fixture.enabled), managedKeys: fixture.managed ? { enablePublicMcp: { managed: true, managedBy: "paperclip-cloud" } } : {} };
  const error = (message: string, status = 503) => Response.json({ error: message }, { status });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const path = url.pathname;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (path === "/api/companies/company-storybook/chat-endpoints" && method === "GET") return Response.json([]);
    const target = path.startsWith("/api/mcp/") || path === "/api/instance/settings/experimental";
    if (!target) return original(input, init);
    if (method === "GET") {
      if (fixture.loading) return new Promise<Response>(() => {});
      if (fixture.unavailable) return error("Assistant connections are unavailable. Check the experimental setting or reconnect.", 403);
      if (path === "/api/instance/settings/experimental") return Response.json(settings);
      if (path === "/api/mcp/setup") return Response.json({ enabled: settings.enablePublicMcp, serverUrl: "https://paperclip.example/mcp/paperclip" });
      if (path === "/api/mcp/connections") return fixture.connectionsUnavailable ? error("Connection status is unavailable.") : Response.json(rows);
      if (path === "/api/mcp/device") return fixture.deviceExpired ? error("This code is expired. Start a new connection from your assistant.", 404) : Response.json({ ...request, clientName: "Paperclip CLI (device)", redirectOrigin: "", ...fixture.request });
      if (path === `/api/mcp/requests/${request.id}`) return Response.json({ ...request, ...fixture.request });
    } else {
      if (fixture.pending) return new Promise<Response>(() => {});
      if (fixture.mutationError) return error("Could not save this change. Please try again.");
      if (path.endsWith("/consent") && method === "POST") {
        consentSubmission(JSON.parse(String(init?.body)));
        if (path === "/api/mcp/device/consent") return Response.json({ status: JSON.parse(String(init?.body)).decision === "approve" ? "approved" : "denied" });
        // Exercise the real redirect without leaving the local Storybook frame.
        return Response.json({ redirectUrl: `${location.href.split("#")[0]}#storybook-consent-recorded` });
      }
      if (path.startsWith("/api/mcp/connections/") && method === "DELETE") {
        rows = rows.map(row => row.id === path.split("/").at(-1) ? { ...row, revokedAt: "2020-01-02T00:00:00Z" } : row);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/instance/settings/experimental" && method === "PATCH") {
        settings = { ...settings, ...JSON.parse(String(init?.body)) };
        return Response.json(settings);
      }
    }
    return error("This action has no Storybook fixture.", 400);
  };
  return () => { window.fetch = original; };
}
