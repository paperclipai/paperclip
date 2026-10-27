import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { loadGitHubGrantMetadata } from "../services/tool-access.js";
import { createConnectionHealth } from "../services/tool-access/catalog/health.js";

vi.mock("../services/tool-access/connections/projection.js", () => ({
  toConnection: (row: { id: string; healthStatus: string; healthMessage: string | null }) => ({
    id: row.id,
    healthStatus: row.healthStatus,
    healthMessage: row.healthMessage,
  }),
}));

const SUSPENDED_INSTALLATION_URL = "https://github.com/organizations/paperclipai/settings/installations/101";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

// GitHub's view of an account whose only installation is suspended.
const suspendedGitHub = vi.fn<typeof fetch>(async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/user") return json({ id: 42, login: "octocat" });
  if (url.pathname === "/user/installations") {
    return json({ installations: [
      { id: 101, app_slug: "paperclip-staging", repository_selection: "all", suspended_at: "2026-10-22T01:33:41Z", html_url: SUSPENDED_INSTALLATION_URL },
    ] });
  }
  if (url.pathname === "/user/installations/101/repositories") {
    return json({ repositories: [{ id: 1, full_name: "paperclipai/a" }] });
  }
  throw new Error(`Unexpected GitHub path: ${url.pathname}`);
});

function githubConnectionHealth() {
  const connection = {
    id: "conn-1",
    companyId: "company-1",
    connectionPurpose: "tools",
    transport: "mcp_remote",
    credentialPolicy: "shared",
    config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
    healthStatus: "ok",
    healthMessage: null,
  };
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ id: "grant-1", kind: "organization", status: "active" }] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({ returning: async () => [{ ...connection, ...values }] }),
      }),
    }),
  } as unknown as Db;
  return createConnectionHealth(db, {
    now: () => new Date(),
    audit: vi.fn(async () => undefined),
    getConnectionRow: async () => connection as never,
    discovery: {} as never,
    setupPolicy: { assertConnectorConnectionSetupEnabled: async () => undefined } as never,
    resolveCredentialHeaders: vi.fn() as never,
    refreshManagedGitHubGrantAccess: (async () => {
      await loadGitHubGrantMetadata("ghu_secret", suspendedGitHub);
    }) as never,
    ensureRuntimeSlot: vi.fn() as never,
    stdioTemplateId: vi.fn() as never,
  });
}

describe("GitHub Refresh access recovery", () => {
  it("keeps the suspended installation's settings link on the health-check failure", async () => {
    const { checkConnectionHealth } = githubConnectionHealth();

    await expect(checkConnectionHealth("conn-1", { actorType: "user", actorId: "user-1" } as never)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("suspended"),
      details: {
        code: "github_installation_required",
        managementUrl: SUSPENDED_INSTALLATION_URL,
        installationUrl: "https://github.com/apps/paperclip-staging/installations/new",
        connection: { id: "conn-1", healthStatus: "error", healthMessage: expect.stringContaining("suspended") },
      },
    });
  });
});
