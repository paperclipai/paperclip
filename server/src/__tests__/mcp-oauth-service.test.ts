import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The SSRF guard resolves hosts via node:dns; pin test hosts to a public IP so
// the guard admits the stubbed OAuth server (real DNS for mcp.example.com etc.
// is unavailable/irrelevant in tests). Loopback/internal literals are rejected
// before lookup, so the guard's own tests still exercise the real logic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { __testing, mcpOauthService } from "../services/mcp-oauth.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("mcp-oauth pure helpers", () => {
  it("builds path-aware well-known candidates", () => {
    expect(__testing.wellKnownCandidates("https://mcp.linear.app/mcp", "oauth-protected-resource")).toEqual([
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
      "https://mcp.linear.app/.well-known/oauth-protected-resource",
    ]);
    expect(
      __testing.wellKnownCandidates("https://auth.example.com", "oauth-authorization-server", true),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("flags private, loopback, link-local, and unique-local addresses", () => {
    for (const addr of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.5.5", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(__testing.isPrivateAddress(addr)).toBe(true);
    }
    for (const addr of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "2600::1"]) {
      expect(__testing.isPrivateAddress(addr)).toBe(false);
    }
  });

  it("rejects SSRF-prone URLs at the fetch guard", async () => {
    await expect(__testing.assertPublicHttpUrl("http://localhost/mcp")).rejects.toThrow(/internal host/i);
    await expect(__testing.assertPublicHttpUrl("http://127.0.0.1/mcp")).rejects.toThrow(/private address/i);
    await expect(__testing.assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private/i);
    await expect(__testing.assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow(/non-http/i);
    await expect(__testing.assertPublicHttpUrl("http://foo.internal/mcp")).rejects.toThrow(/internal/i);
  });

  it("parses token payloads and rejects incomplete ones", () => {
    expect(
      __testing.parseTokenPayload(
        JSON.stringify({
          accessToken: "a",
          tokenEndpoint: "https://auth.example.com/token",
          clientId: "c",
          resource: "https://mcp.example.com/mcp",
        }),
      ),
    ).toMatchObject({ accessToken: "a", clientId: "c" });
    expect(__testing.parseTokenPayload(JSON.stringify({ accessToken: "a" }))).toBeNull();
    expect(__testing.parseTokenPayload("not json")).toBeNull();
  });
});

describeEmbeddedPostgres("mcpOauthService — brokered flow", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-mcp-oauth-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("mcp-oauth");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    __testing.pendingChallenges.clear();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Bot",
      role: "general",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        mcpServers: {
          linear: { transport: "http", url: "https://mcp.example.com/mcp" },
        },
      },
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId };
  }

  function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
    return new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  }

  function stubOauthServerFetch(overrides?: {
    tokenResponses?: Array<Record<string, unknown>>;
  }) {
    const tokenResponses = overrides?.tokenResponses ?? [
      {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
      },
    ];
    let tokenCalls = 0;
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
        if (url.includes("/.well-known/oauth-protected-resource")) {
          return jsonResponse({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: ["https://auth.example.com"],
          });
        }
        if (url.includes("/.well-known/oauth-authorization-server")) {
          return jsonResponse({
            issuer: "https://auth.example.com",
            authorization_endpoint: "https://auth.example.com/authorize",
            token_endpoint: "https://auth.example.com/token",
            registration_endpoint: "https://auth.example.com/register",
            scopes_supported: ["mcp.read", "mcp.write"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url === "https://auth.example.com/register") {
          return jsonResponse({ client_id: "client-123" }, { status: 201 });
        }
        if (url === "https://auth.example.com/token") {
          const response = tokenResponses[Math.min(tokenCalls, tokenResponses.length - 1)];
          tokenCalls += 1;
          return jsonResponse(response);
        }
        return new Response("not found", { status: 404 });
      }),
    );
    return { calls, tokenCallCount: () => tokenCalls };
  }

  it("runs discovery -> DCR -> authorize URL -> callback -> stores token secret and updates agent config", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const { calls } = stubOauthServerFetch();
    const svc = mcpOauthService(db);

    const { authorizeUrl, state } = await svc.startAuthorization({
      companyId,
      agentId,
      serverName: "linear",
      serverUrl: "https://mcp.example.com/mcp",
      redirectUri: "http://localhost:3100/api/mcp-oauth/callback",
    });

    const parsedAuthorize = new URL(authorizeUrl);
    expect(parsedAuthorize.origin).toBe("https://auth.example.com");
    expect(parsedAuthorize.searchParams.get("client_id")).toBe("client-123");
    expect(parsedAuthorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsedAuthorize.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(parsedAuthorize.searchParams.get("state")).toBe(state);

    const result = await svc.handleCallback({ state, code: "auth-code-1" });
    expect(result).toMatchObject({ agentId, serverName: "linear" });

    // Token exchange used PKCE + resource indicator.
    const tokenCall = calls.find((call) => call.url === "https://auth.example.com/token");
    expect(tokenCall?.body).toContain("grant_type=authorization_code");
    expect(tokenCall?.body).toContain("code_verifier=");
    expect(tokenCall?.body).toContain("resource=");

    // Agent config now references the oauth secret.
    const [agentRow] = await db.select().from(agents);
    const mcpServers = (agentRow.adapterConfig as Record<string, unknown>).mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    const auth = mcpServers.linear.auth as Record<string, unknown>;
    expect(auth.type).toBe("oauth");
    expect(auth.secretId).toBe(result.secretId);

    // The stored secret resolves to a payload whose access token the runtime
    // resolver turns into a bearer header.
    const secrets = secretService(db);
    const raw = await secrets.resolveSecretValue(companyId, result.secretId, "latest");
    expect(JSON.parse(raw)).toMatchObject({ accessToken: "at-1", clientId: "client-123" });

    const { config } = await secrets.resolveAdapterConfigForRuntime(
      companyId,
      agentRow.adapterConfig as Record<string, unknown>,
    );
    const resolved = config.mcpServers as Record<string, Record<string, unknown>>;
    expect((resolved.linear.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
  });

  it("refreshes expiring tokens before a run and keeps the old refresh token when the AS omits it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    stubOauthServerFetch({
      tokenResponses: [
        { access_token: "at-1", refresh_token: "rt-1", expires_in: 60 }, // initial exchange: expires soon
        { access_token: "at-2", expires_in: 3600 }, // refresh: no rotated refresh token
      ],
    });
    const svc = mcpOauthService(db);

    const { state } = await svc.startAuthorization({
      companyId,
      agentId,
      serverName: "linear",
      serverUrl: "https://mcp.example.com/mcp",
      redirectUri: "http://localhost:3100/api/mcp-oauth/callback",
    });
    const { secretId } = await svc.handleCallback({ state, code: "auth-code-1" });

    const [agentRow] = await db.select().from(agents);
    await svc.refreshExpiringTokensForAgent({
      id: agentId,
      companyId,
      adapterConfig: agentRow.adapterConfig,
    });

    const secrets = secretService(db);
    const raw = await secrets.resolveSecretValue(companyId, secretId, "latest");
    expect(JSON.parse(raw)).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });

  it("rejects expired/unknown callback state", async () => {
    const svc = mcpOauthService(db);
    await expect(svc.handleCallback({ state: "nope", code: "c" })).rejects.toThrow(/unknown or expired/i);
  });
});
