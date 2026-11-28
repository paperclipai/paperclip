import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInfisicalProvider,
  InfisicalHttpGateway,
  parseInfisicalExternalRef,
  resetInfisicalTokenCache,
} from "../secrets/infisical-provider.js";
import type { SecretProviderVaultRuntimeConfig } from "../secrets/types.js";
import { SecretProviderClientError } from "../secrets/types.js";

const SITE_URL = "https://infisical.example.test";
const TEST_CLIENT_ID = "test-client-id";
const TEST_CLIENT_SECRET = "test-client-secret-not-real";

const ENV_KEYS = [
  "PAPERCLIP_SECRETS_INFISICAL_SITE_URL",
  "PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID",
  "PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET",
  "PAPERCLIP_SECRETS_INFISICAL_PROJECT_ID",
  "PAPERCLIP_SECRETS_INFISICAL_ENVIRONMENT",
  "PAPERCLIP_SECRETS_INFISICAL_SECRET_PATH",
  "PAPERCLIP_SECRETS_INFISICAL_ALLOWED_PROJECT_IDS",
] as const;

function vault(config: Record<string, unknown> = {}, status = "ready"): SecretProviderVaultRuntimeConfig {
  return {
    id: "vault-1",
    provider: "infisical",
    status,
    config: { projectId: "proj-123", environment: "prod", secretPath: "/paperclip", ...config },
  };
}

type FetchCall = { url: URL; method: string; headers: Record<string, string>; body: unknown };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockInfisical(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function loginOk(call: FetchCall, token = "access-token-1") {
  if (call.url.pathname === "/api/v1/auth/universal-auth/login") {
    return jsonResponse(200, { accessToken: token, expiresIn: 7200, tokenType: "Bearer" });
  }
  return null;
}

describe("infisicalProvider", () => {
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    resetInfisicalTokenCache();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.PAPERCLIP_SECRETS_INFISICAL_SITE_URL = SITE_URL;
    process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID = TEST_CLIENT_ID;
    process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET = TEST_CLIENT_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetInfisicalTokenCache();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("externalRef parsing", () => {
    const defaults = { secretPath: "/paperclip", environment: "prod" };

    it.each([
      ["GITHUB_TOKEN", { secretPath: "/paperclip", secretKey: "GITHUB_TOKEN", environment: "prod" }],
      ["GITHUB_TOKEN@dev", { secretPath: "/paperclip", secretKey: "GITHUB_TOKEN", environment: "dev" }],
      ["/agents:GITHUB_TOKEN", { secretPath: "/agents", secretKey: "GITHUB_TOKEN", environment: "prod" }],
      ["/paperclip:GITHUB_TOKEN@prod", { secretPath: "/paperclip", secretKey: "GITHUB_TOKEN", environment: "prod" }],
      ["/a/b/c/GITHUB_TOKEN@staging", { secretPath: "/a/b/c", secretKey: "GITHUB_TOKEN", environment: "staging" }],
      ["/:ROOT_KEY", { secretPath: "/", secretKey: "ROOT_KEY", environment: "prod" }],
      ["  /paperclip/:KEY  ", { secretPath: "/paperclip", secretKey: "KEY", environment: "prod" }],
    ])("parses %s", (externalRef, expected) => {
      expect(parseInfisicalExternalRef(externalRef, defaults)).toEqual(expected);
    });

    it.each([
      [""],
      ["/paperclip:"],
      ["/paperclip:BAD KEY"],
      ["/../etc:KEY"],
      ["KEY@"],
      ["KEY@prod env"],
    ])("rejects %j", (externalRef) => {
      expect(() => parseInfisicalExternalRef(externalRef, defaults)).toThrow();
    });
  });

  describe("linkExternalSecret", () => {
    it("canonicalizes the reference and stores no plaintext", async () => {
      const { fetchMock } = mockInfisical(() => jsonResponse(500, {}));
      const provider = createInfisicalProvider();

      const prepared = await provider.linkExternalSecret({
        externalRef: "/paperclip/GITHUB_TOKEN",
        providerConfig: vault(),
      });

      expect(prepared.externalRef).toBe("/paperclip:GITHUB_TOKEN@prod");
      expect(prepared.providerVersionRef).toBeNull();
      expect(prepared.material).toEqual({
        scheme: "infisical_v1",
        source: "external_reference",
        secretPath: "/paperclip",
        secretKey: "GITHUB_TOKEN",
        environment: "prod",
        version: null,
      });
      expect(prepared.valueSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("pins numeric Infisical versions and rejects other version refs", async () => {
      const provider = createInfisicalProvider();
      const pinned = await provider.linkExternalSecret({
        externalRef: "GITHUB_TOKEN",
        providerVersionRef: "7",
        providerConfig: vault(),
      });
      expect(pinned.providerVersionRef).toBe("7");
      expect(pinned.material).toMatchObject({ version: "7" });

      await expect(provider.linkExternalSecret({
        externalRef: "GITHUB_TOKEN",
        providerVersionRef: "latest",
        providerConfig: vault(),
      })).rejects.toThrow(/positive integer/);
      for (const providerVersionRef of ["0", "000"]) {
        await expect(provider.linkExternalSecret({
          externalRef: "GITHUB_TOKEN",
          providerVersionRef,
          providerConfig: vault(),
        })).rejects.toThrow(/positive integer/);
      }
    });
  });

  describe("provider vault config", () => {
    it("refuses to send machine identity credentials to a site other than the deployment site", async () => {
      const { fetchMock } = mockInfisical(() => jsonResponse(200, {}));
      const provider = createInfisicalProvider();

      await expect(provider.resolveVersion({
        material: {},
        externalRef: "/paperclip:KEY@prod",
        providerConfig: vault({ siteUrl: "https://attacker.example.test" }),
      })).rejects.toThrow(/must match the deployment Infisical site/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("enforces the deployment project allowlist", async () => {
      process.env.PAPERCLIP_SECRETS_INFISICAL_ALLOWED_PROJECT_IDS = "proj-allowed, proj-other";
      const provider = createInfisicalProvider();

      await expect(provider.linkExternalSecret({
        externalRef: "KEY",
        providerConfig: vault({ projectId: "proj-123" }),
      })).rejects.toThrow(/ALLOWED_PROJECT_IDS/);
      await expect(provider.linkExternalSecret({
        externalRef: "KEY",
        providerConfig: vault({ projectId: "proj-allowed" }),
      })).resolves.toMatchObject({ externalRef: "/paperclip:KEY@prod" });
    });

    it("rejects disabled vaults and missing required config", async () => {
      const provider = createInfisicalProvider();
      await expect(provider.linkExternalSecret({
        externalRef: "KEY",
        providerConfig: vault({}, "disabled"),
      })).rejects.toThrow(/disabled/);
      await expect(provider.linkExternalSecret({
        externalRef: "KEY",
        providerConfig: { id: "v", provider: "infisical", status: "ready", config: { environment: "prod" } },
      })).rejects.toThrow(/projectId/);
    });
  });

  describe("auth and resolve", () => {
    it("logs in with Universal Auth, caches the token, and reads the raw secret", async () => {
      const { calls } = mockInfisical((call) => {
        const login = loginOk(call);
        if (login) return login;
        return jsonResponse(200, { secret: { secretKey: "GITHUB_TOKEN", secretValue: "resolved-value", version: 3 } });
      });
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "GITHUB_TOKEN", providerConfig: vault() });

      const first = await provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      });
      const second = await provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      });

      expect(first).toBe("resolved-value");
      expect(second).toBe("resolved-value");
      const logins = calls.filter((call) => call.url.pathname === "/api/v1/auth/universal-auth/login");
      expect(logins).toHaveLength(1);
      expect(logins[0]).toMatchObject({
        method: "POST",
        body: { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET },
      });
      expect(logins[0]?.url.origin).toBe(SITE_URL);

      const reads = calls.filter((call) => call.url.pathname.startsWith("/api/v3/secrets/raw/"));
      expect(reads).toHaveLength(2);
      expect(reads[0]?.url.pathname).toBe("/api/v3/secrets/raw/GITHUB_TOKEN");
      expect(Object.fromEntries(reads[0]!.url.searchParams)).toEqual({
        workspaceId: "proj-123",
        environment: "prod",
        secretPath: "/paperclip",
        type: "shared",
      });
      expect(reads[0]?.headers.authorization).toBe("Bearer access-token-1");
    });

    it("passes pinned versions through to Infisical", async () => {
      const { calls } = mockInfisical((call) => loginOk(call) ?? jsonResponse(200, { secret: { secretValue: "v7" } }));
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({
        externalRef: "/paperclip:KEY@prod",
        providerVersionRef: "7",
        providerConfig: vault(),
      });

      await expect(provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerVersionRef: linked.providerVersionRef,
        providerConfig: vault(),
      })).resolves.toBe("v7");
      const read = calls.find((call) => call.url.pathname.startsWith("/api/v3/secrets/raw/"));
      expect(read?.url.searchParams.get("version")).toBe("7");
    });

    it("shares one replacement login across concurrent requests rejected with the same token", async () => {
      let logins = 0;
      mockInfisical((call) => {
        if (call.url.pathname === "/api/v1/auth/universal-auth/login") {
          logins += 1;
          return jsonResponse(200, { accessToken: `token-${logins}`, expiresIn: 7200 });
        }
        if (call.headers.authorization === "Bearer token-1") {
          return jsonResponse(401, { message: "Token expired" });
        }
        return jsonResponse(200, { secret: { secretValue: "fresh" } });
      });
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY", providerConfig: vault() });
      const resolve = () => provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      });

      const results = await Promise.all([resolve(), resolve(), resolve()]);

      expect(results).toEqual(["fresh", "fresh", "fresh"]);
      expect(logins).toBe(2);
    });

    it("treats non-JSON success responses as provider errors", async () => {
      mockInfisical((call) => loginOk(call) ?? new Response("<html>proxy</html>", { status: 200 }));
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY", providerConfig: vault() });

      await expect(provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      })).rejects.toMatchObject({ code: "provider_unavailable" });
      const health = await provider.healthCheck({ providerConfig: vault() });
      expect(health.status).toBe("error");
    });

    it("re-authenticates once when a cached token is rejected", async () => {
      let reads = 0;
      let logins = 0;
      mockInfisical((call) => {
        if (call.url.pathname === "/api/v1/auth/universal-auth/login") {
          logins += 1;
          return jsonResponse(200, { accessToken: `token-${logins}`, expiresIn: 7200 });
        }
        reads += 1;
        if (call.headers.authorization === "Bearer token-1") {
          return jsonResponse(401, { message: "Token expired" });
        }
        return jsonResponse(200, { secret: { secretValue: "fresh" } });
      });
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY", providerConfig: vault() });

      await expect(provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      })).resolves.toBe("fresh");
      expect(logins).toBe(2);
      expect(reads).toBe(2);
    });

    it("maps login failures to access_denied without leaking the client secret", async () => {
      mockInfisical(() => jsonResponse(401, { message: "Invalid credentials" }));
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY", providerConfig: vault() });

      const error = await provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SecretProviderClientError);
      expect(error).toMatchObject({ code: "access_denied", provider: "infisical", operation: "login" });
      const serialized = `${(error as Error).message} ${(error as SecretProviderClientError).rawMessage}`;
      expect(serialized).not.toContain(TEST_CLIENT_SECRET);
    });

    it.each([
      [404, "not_found"],
      [403, "access_denied"],
      [429, "throttled"],
      [503, "provider_unavailable"],
    ] as const)("maps Infisical HTTP %i on read to %s", async (status, code) => {
      mockInfisical((call) => loginOk(call) ?? jsonResponse(status, { message: "nope" }));
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY", providerConfig: vault() });

      await expect(provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      })).rejects.toMatchObject({ code, operation: "getSecret" });
    });

    it("maps network failures to provider_unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new TypeError("fetch failed");
      }));
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY", providerConfig: vault() });

      await expect(provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      })).rejects.toMatchObject({ code: "provider_unavailable" });
    });

    it("fails clearly when machine identity credentials are missing", async () => {
      delete process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET;
      const { fetchMock } = mockInfisical(() => jsonResponse(200, {}));
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY", providerConfig: vault() });

      await expect(provider.resolveVersion({
        material: linked.material,
        externalRef: linked.externalRef,
        providerConfig: vault(),
      })).rejects.toThrow(/PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uses deployment env config when no provider vault is selected", async () => {
      process.env.PAPERCLIP_SECRETS_INFISICAL_PROJECT_ID = "proj-env";
      process.env.PAPERCLIP_SECRETS_INFISICAL_ENVIRONMENT = "staging";
      process.env.PAPERCLIP_SECRETS_INFISICAL_SECRET_PATH = "/agents";
      const { calls } = mockInfisical((call) => loginOk(call) ?? jsonResponse(200, { secret: { secretValue: "x" } }));
      const provider = createInfisicalProvider();
      const linked = await provider.linkExternalSecret({ externalRef: "KEY" });

      expect(linked.externalRef).toBe("/agents:KEY@staging");
      await provider.resolveVersion({ material: linked.material, externalRef: linked.externalRef });
      const read = calls.find((call) => call.url.pathname.startsWith("/api/v3/secrets/raw/"));
      expect(read?.url.searchParams.get("workspaceId")).toBe("proj-env");
    });
  });

  describe("remote listing and discovery", () => {
    const listed = [
      { secretKey: "GITHUB_TOKEN", secretValue: "leak-1", secretPath: "/paperclip", version: 2, tags: [{ slug: "agents" }] },
      { secretKey: "OPENAI_API_KEY", secretValue: "leak-2", secretPath: "/paperclip", version: 1 },
      { secretKey: "SLACK_TOKEN", secretValue: "leak-3", secretPath: "/paperclip/slack", version: 4 },
    ];

    it("lists names recursively, never returning secret values, with offset paging", async () => {
      const { calls } = mockInfisical((call) => loginOk(call) ?? jsonResponse(200, { secrets: listed }));
      const provider = createInfisicalProvider();

      const page1 = await provider.listRemoteSecrets!({ providerConfig: vault(), pageSize: 2 });
      const page2 = await provider.listRemoteSecrets!({ providerConfig: vault(), pageSize: 2, nextToken: page1.nextToken });

      expect(page1.secrets.map((entry) => entry.externalRef)).toEqual([
        "/paperclip:GITHUB_TOKEN@prod",
        "/paperclip:OPENAI_API_KEY@prod",
      ]);
      expect(page1.nextToken).toBe("2");
      expect(page2.secrets.map((entry) => entry.externalRef)).toEqual(["/paperclip/slack:SLACK_TOKEN@prod"]);
      expect(page2.nextToken).toBeNull();
      expect(JSON.stringify([page1, page2])).not.toMatch(/leak-/);

      const list = calls.find((call) => call.url.pathname === "/api/v3/secrets/raw");
      expect(list?.url.searchParams.get("recursive")).toBe("true");
      expect(list?.url.searchParams.get("viewSecretValue")).toBe("false");
      expect(list?.url.searchParams.get("secretPath")).toBe("/paperclip");
    });

    it("filters listings by query", async () => {
      mockInfisical((call) => loginOk(call) ?? jsonResponse(200, { secrets: listed }));
      const provider = createInfisicalProvider();
      const result = await provider.listRemoteSecrets!({ providerConfig: vault(), query: "slack" });
      expect(result.secrets.map((entry) => entry.name)).toEqual(["/paperclip/slack/SLACK_TOKEN"]);
    });

    it("discovers one provider vault candidate per folder", async () => {
      mockInfisical((call) => loginOk(call) ?? jsonResponse(200, { secrets: listed }));
      const provider = createInfisicalProvider();

      const preview = await provider.discoverProviderConfigs!({
        companyId: "company-1",
        providerConfig: vault({ secretPath: "/" }),
      });

      expect(preview.provider).toBe("infisical");
      expect(preview.sampledSecretCount).toBe(3);
      expect(preview.candidates.map((candidate) => candidate.config)).toEqual([
        { siteUrl: null, projectId: "proj-123", environment: "prod", secretPath: "/paperclip" },
        { siteUrl: null, projectId: "proj-123", environment: "prod", secretPath: "/paperclip/slack" },
      ]);
      expect(preview.candidates[0]?.samples.map((sample) => sample.name)).toEqual(["GITHUB_TOKEN", "OPENAI_API_KEY"]);
      expect(JSON.stringify(preview)).not.toMatch(/leak-/);
    });
  });

  describe("updateExternalSecretValue", () => {
    it("PATCHes the raw secret and keeps tracking the latest version", async () => {
      const { calls } = mockInfisical((call) =>
        loginOk(call) ?? jsonResponse(200, { secret: { secretKey: "KEY", version: 9 } }));
      const provider = createInfisicalProvider();

      const prepared = await provider.updateExternalSecretValue!({
        externalRef: "/paperclip:KEY@prod",
        value: "new-value",
        providerConfig: vault(),
      });

      const patch = calls.find((call) => call.method === "PATCH");
      expect(patch?.url.pathname).toBe("/api/v3/secrets/raw/KEY");
      expect(patch?.body).toEqual({
        workspaceId: "proj-123",
        environment: "prod",
        secretPath: "/paperclip",
        secretValue: "new-value",
        type: "shared",
      });
      expect(prepared.providerVersionRef).toBeNull();
      expect(prepared.material).toMatchObject({ version: null, lastWrittenVersion: "9" });
      expect(JSON.stringify(prepared.material)).not.toContain("new-value");
    });
  });

  describe("managed values", () => {
    it("rejects Paperclip-managed creates", async () => {
      const provider = createInfisicalProvider();
      await expect(provider.createSecret({ value: "x", providerConfig: vault() })).rejects.toThrow(/only links/);
      await expect(provider.createVersion({ value: "x", providerConfig: vault() })).rejects.toThrow(/only links/);
    });

    it("never deletes upstream Infisical secrets", async () => {
      const { fetchMock } = mockInfisical(() => jsonResponse(200, {}));
      const provider = createInfisicalProvider();
      await provider.deleteOrArchive({ externalRef: "/paperclip:KEY@prod", mode: "delete", providerConfig: vault() });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("healthCheck", () => {
    it("reports ok for a provider vault the identity can read", async () => {
      const { calls } = mockInfisical((call) => loginOk(call) ?? jsonResponse(200, { secrets: [] }));
      const provider = createInfisicalProvider();
      const health = await provider.healthCheck({ providerConfig: vault() });
      expect(health).toMatchObject({ provider: "infisical", status: "ok" });
      const list = calls.find((call) => call.url.pathname === "/api/v3/secrets/raw");
      expect(list?.url.searchParams.get("recursive")).toBe("false");
    });

    it("reports error with access guidance when Infisical rejects the identity", async () => {
      mockInfisical(() => jsonResponse(401, { message: "Invalid credentials" }));
      const provider = createInfisicalProvider();
      const health = await provider.healthCheck({ providerConfig: vault() });
      expect(health).toMatchObject({ status: "error", details: { code: "access_denied" } });
      expect(health.warnings?.join("\n")).toMatch(/machine identity/);
      expect(JSON.stringify(health)).not.toContain(TEST_CLIENT_SECRET);
    });

    it("reports error when Infisical is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new TypeError("fetch failed");
      }));
      const provider = createInfisicalProvider();
      const health = await provider.healthCheck({ providerConfig: vault() });
      expect(health).toMatchObject({ status: "error", details: { code: "provider_unavailable" } });
    });

    it("warns without network calls when credentials are missing", async () => {
      delete process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID;
      const { fetchMock } = mockInfisical(() => jsonResponse(200, {}));
      const provider = createInfisicalProvider();
      const health = await provider.healthCheck({ providerConfig: vault() });
      expect(health.status).toBe("warn");
      expect(health.message).toContain("PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("warns when the provider vault points at another site", async () => {
      const provider = createInfisicalProvider();
      const health = await provider.healthCheck({ providerConfig: vault({ siteUrl: "https://elsewhere.example.test" }) });
      expect(health.status).toBe("warn");
      expect(health.message).toMatch(/must match the deployment Infisical site/);
    });

    it("stays offline for the deployment-wide check", async () => {
      const { fetchMock } = mockInfisical(() => jsonResponse(200, {}));
      process.env.PAPERCLIP_SECRETS_INFISICAL_PROJECT_ID = "proj-env";
      process.env.PAPERCLIP_SECRETS_INFISICAL_ENVIRONMENT = "prod";
      const provider = createInfisicalProvider();
      await expect(provider.healthCheck()).resolves.toMatchObject({ status: "ok" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("descriptor", () => {
    it("advertises external references only and reflects credential presence", () => {
      const provider = createInfisicalProvider();
      expect(provider.descriptor()).toEqual({
        id: "infisical",
        label: "Infisical",
        requiresExternalRef: true,
        supportsManagedValues: false,
        supportsExternalReferences: true,
        supportsExternalValueWrites: true,
        configured: true,
      });
      delete process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID;
      expect(provider.descriptor().configured).toBe(false);
    });
  });

  it("InfisicalHttpGateway refuses redirects so credentials stay on the configured origin", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { accessToken: "t", expiresIn: 60 }));
    const gateway = new InfisicalHttpGateway(SITE_URL, () => ({ clientId: "id", clientSecret: "secret" }), fetchMock);
    await gateway.accessToken();
    expect(fetchMock).toHaveBeenCalledWith(
      `${SITE_URL}/api/v1/auth/universal-auth/login`,
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
