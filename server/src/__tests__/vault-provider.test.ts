import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedKvPath,
  createVaultProvider,
  detectVaultAuthSource,
  parseExternalRef,
  resolveVaultConfig,
  VaultTokenManager,
  withVaultTokenRetry,
  type VaultAuthSource,
} from "../secrets/vault-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";

describe("vaultProvider", () => {
  const previousEnv = {
    PAPERCLIP_SECRETS_VAULT_ADDR: process.env.PAPERCLIP_SECRETS_VAULT_ADDR,
    PAPERCLIP_SECRETS_VAULT_KV_MOUNT: process.env.PAPERCLIP_SECRETS_VAULT_KV_MOUNT,
    PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX: process.env.PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX,
    PAPERCLIP_SECRETS_VAULT_NAMESPACE: process.env.PAPERCLIP_SECRETS_VAULT_NAMESPACE,
    PAPERCLIP_SECRETS_VAULT_AUTH_METHOD: process.env.PAPERCLIP_SECRETS_VAULT_AUTH_METHOD,
    PAPERCLIP_SECRETS_VAULT_K8S_ROLE: process.env.PAPERCLIP_SECRETS_VAULT_K8S_ROLE,
    PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION: process.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION,
    PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH: process.env.PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH,
    VAULT_ADDR: process.env.VAULT_ADDR,
    VAULT_TOKEN: process.env.VAULT_TOKEN,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("constructs a module with id=vault", () => {
    const provider = createVaultProvider({
      config: {
        address: "https://vault.example:8200",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: {} as never,
    });
    expect(provider.id).toBe("vault");
  });
});

describe("validateConfig — address rules", () => {
  function makeProvider() {
    return createVaultProvider({ gateway: {} as never });
  }

  it("accepts a clean http(s) origin", async () => {
    const provider = makeProvider();
    const r = await provider.validateConfig({
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://vault.example:8200" },
      },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects address with embedded credentials", async () => {
    const provider = makeProvider();
    const r = await provider.validateConfig({
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://user:pass@vault.example:8200" },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/credentials/i);
  });

  it("rejects address with path/query/fragment", async () => {
    const provider = makeProvider();
    for (const bad of [
      "https://vault.example/path",
      "https://vault.example?q=1",
      "https://vault.example#x",
    ]) {
      const r = await provider.validateConfig({
        providerConfig: {
          id: "v1",
          provider: "vault",
          status: "ready",
          config: { address: bad },
        },
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects non-http(s) schemes and unparseable addresses", async () => {
    const provider = makeProvider();
    for (const bad of ["file:///etc/passwd", "ftp://vault.example", "not a url"]) {
      const r = await provider.validateConfig({
        providerConfig: {
          id: "v1",
          provider: "vault",
          status: "ready",
          config: { address: bad },
        },
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects missing address", async () => {
    const provider = makeProvider();
    const r = await provider.validateConfig({
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {},
      },
    });
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/address/i);
  });
});

describe("validateConfig — mount, prefix, role, retention", () => {
  function check(config: Record<string, unknown>) {
    return createVaultProvider({ gateway: {} as never }).validateConfig({
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://vault.example:8200", ...config },
      },
    });
  }

  it("rejects kvMount with slashes", async () => {
    const r = await check({ kvMount: "secret/foo" });
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/kvMount/);
  });

  it("rejects kvMount that starts with 'data/'", async () => {
    const r = await check({ kvMount: "data/foo" });
    expect(r.ok).toBe(false);
  });

  it("rejects kvPathPrefix with leading slash", async () => {
    const r = await check({ kvPathPrefix: "/paperclip" });
    expect(r.ok).toBe(false);
  });

  it("requires role when auth.method = kubernetes", async () => {
    const r = await check({ auth: { method: "kubernetes" } });
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/role/);
  });

  it("rejects malformed role string", async () => {
    const r = await check({
      auth: { method: "kubernetes", role: "bad role!" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects versionRetention below MIN_VERSION_RETENTION", async () => {
    const r = await check({ versionRetention: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects versionRetention above MAX_VERSION_RETENTION", async () => {
    const r = await check({ versionRetention: 101 });
    expect(r.ok).toBe(false);
  });

  it("accepts a fully valid kubernetes-auth config", async () => {
    const r = await check({
      kvMount: "secret",
      kvPathPrefix: "paperclip",
      auth: { method: "kubernetes", role: "paperclip-server" },
      versionRetention: 25,
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateConfig — credential-shaped-field denylist", () => {
  function check(extra: Record<string, unknown>) {
    return createVaultProvider({ gateway: {} as never }).validateConfig({
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://vault.example:8200", ...extra },
      },
    });
  }

  const banned = [
    "token", "password", "roleId", "secretId",
    "unsealKey", "clientCert", "privateKey",
    "accessKeyId", "secretAccessKey", "serviceAccountJson",
    "keyFile",
  ];

  for (const key of banned) {
    it(`rejects vault config containing key '${key}'`, async () => {
      const r = await check({ [key]: "anything" });
      expect(r.ok).toBe(false);
      expect(r.warnings.join(" ")).toMatch(new RegExp(key, "i"));
    });
  }

  it("denylist is case-insensitive", async () => {
    const r = await check({ TOKEN: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("resolveVaultConfig", () => {
  it("uses static defaults when nothing is set", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://vault.default:8200" },
      providerConfig: null
    });
    expect(r.config?.kvMount).toBe("secret");
    expect(r.config?.kvPathPrefix).toBe("paperclip");
    expect(r.config?.versionRetention).toBe(10);
    expect(r.config?.auth.saTokenPath).toBe(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    );
  });

  it("reads from env when no vault config is given", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://vault.env:8200",
        PAPERCLIP_SECRETS_VAULT_KV_MOUNT: "kv",
        PAPERCLIP_SECRETS_VAULT_AUTH_METHOD: "kubernetes",
        PAPERCLIP_SECRETS_VAULT_K8S_ROLE: "paperclip-server",
      },
      providerConfig: null,
    });
    expect(r.config?.address).toBe("https://vault.env:8200");
    expect(r.config?.kvMount).toBe("kv");
    expect(r.config?.auth.method).toBe("kubernetes");
    expect(r.config?.auth.role).toBe("paperclip-server");
  });

  it("vault config overrides env", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://from-env:8200" },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://from-config:8200" },
      },
    });
    expect(r.config?.address).toBe("https://from-config:8200");
  });

  it("returns errors when address is missing entirely", () => {
    const r = resolveVaultConfig({ env: {}, providerConfig: null });
    expect(r.config).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/address/i);
  });
});

describe("detectVaultAuthSource", () => {
  it("returns token mode when VAULT_TOKEN env is set", () => {
    const r: VaultAuthSource = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      env: { VAULT_TOKEN: "hvs.abc" },
      readSaToken: () => null,
    });
    expect(r.mode).toBe("token");
    if (r.mode === "token") expect(r.token).toBe("hvs.abc");
  });

  it("returns kubernetes mode when SA token mount exists", () => {
    const r = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "kubernetes", role: "paperclip-server", saTokenPath: "/var/run/sa" },
        versionRetention: 10,
      },
      env: {},
      readSaToken: (path) => (path === "/var/run/sa" ? "eyJ.fake.jwt" : null),
    });
    expect(r.mode).toBe("kubernetes");
    if (r.mode === "kubernetes") {
      expect(r.role).toBe("paperclip-server");
      expect(r.jwt).toBe("eyJ.fake.jwt");
    }
  });

  it("returns error when no auth source is detectable", () => {
    const r = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      env: {},
      readSaToken: () => null,
    });
    expect(r.mode).toBe("error");
    if (r.mode === "error") expect(r.message).toMatch(/no Vault auth source/i);
  });

  it("respects explicit auth.method=kubernetes even when VAULT_TOKEN is set", () => {
    const r = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "kubernetes", role: "paperclip-server", saTokenPath: "/sa" },
        versionRetention: 10,
      },
      env: { VAULT_TOKEN: "hvs.shouldBeIgnored" },
      readSaToken: () => "eyJ.fake",
    });
    expect(r.mode).toBe("kubernetes");
  });
});

describe("buildManagedKvPath", () => {
  it("joins prefix, deployment, company, key", () => {
    const path = buildManagedKvPath({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      deploymentId: "prod-eu1",
      companyId: "co_12345",
      secretKey: "GH_TOKEN",
    });
    expect(path).toBe("paperclip/prod-eu1/co_12345/GH_TOKEN");
  });

  it("does not include the mount or 'data/' segment", () => {
    const path = buildManagedKvPath({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "kv",
        kvPathPrefix: "team/secrets",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      deploymentId: "d",
      companyId: "c",
      secretKey: "k",
    });
    expect(path).toBe("team/secrets/d/c/k");
    expect(path.startsWith("kv/")).toBe(false);
    expect(path.includes("/data/")).toBe(false);
  });
});

describe("parseExternalRef", () => {
  it("parses mount/path with default key", () => {
    const r = parseExternalRef("secret/teams/platform/github-token");
    expect(r).toEqual({
      mount: "secret",
      path: "teams/platform/github-token",
      dataKey: "value",
    });
  });

  it("parses mount/path#dataKey", () => {
    const r = parseExternalRef("secret/teams/platform/gh#token");
    expect(r).toEqual({
      mount: "secret",
      path: "teams/platform/gh",
      dataKey: "token",
    });
  });

  it("rejects missing mount or path", () => {
    expect(() => parseExternalRef("secret")).toThrow();
    expect(() => parseExternalRef("")).toThrow();
    expect(() => parseExternalRef("/")).toThrow();
  });
});

describe("VaultTokenManager", () => {
  function fakeGateway() {
    return {
      loginKubernetes: vi.fn(async () => ({
        clientToken: "hvs.kube.1",
        leaseDurationSec: 100,
        renewable: true,
      })),
      renewSelf: vi.fn(async () => ({ leaseDurationSec: 100, renewable: true })),
    };
  }

  it("performs initial login on first acquire (kubernetes mode)", async () => {
    const gw = fakeGateway();
    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" },
      gateway: gw as never,
      now: () => 0,
    });
    expect(await tm.acquire()).toBe("hvs.kube.1");
    expect(gw.loginKubernetes).toHaveBeenCalledTimes(1);
  });

  it("returns the static token in token mode without calling the gateway", async () => {
    const gw = { loginKubernetes: vi.fn(), renewSelf: vi.fn() };
    const tm = new VaultTokenManager({
      source: { mode: "token", token: "static" },
      gateway: gw as never,
      now: () => 0,
    });
    expect(await tm.acquire()).toBe("static");
    expect(gw.loginKubernetes).not.toHaveBeenCalled();
  });

  it("renews proactively past the 70% TTL threshold", async () => {
    const gw = fakeGateway();
    let t = 0;
    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" },
      gateway: gw as never,
      now: () => t,
    });
    await tm.acquire();              // t=0, ttl 100s
    t = 71_000;                       // 71% elapsed
    await tm.acquire();
    expect(gw.renewSelf).toHaveBeenCalledTimes(1);
  });

  it("treats tokens within the 30s skew window as expired and re-logs-in", async () => {
    const gw = fakeGateway();
    let t = 0;
    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" },
      gateway: gw as never,
      now: () => t,
    });
    await tm.acquire();
    t = 75_000;                       // within 30s of 100s expiry
    gw.renewSelf.mockRejectedValueOnce(new Error("renewal failed"));
    await tm.acquire();
    expect(gw.loginKubernetes).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces a fresh login next acquire", async () => {
    const gw = fakeGateway();
    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" },
      gateway: gw as never,
      now: () => 0,
    });
    await tm.acquire();
    tm.invalidate();
    await tm.acquire();
    expect(gw.loginKubernetes).toHaveBeenCalledTimes(2);
  });
});

type FakeStore = Map<string, { versions: string[][] }>;

function fakeVaultGateway(): {
  store: FakeStore;
  maxVersions: Map<string, number>;
  impl: import("../secrets/vault-provider.js").VaultHttpGateway;
} {
  const store: FakeStore = new Map();
  const maxVersions = new Map<string, number>();
  return {
    store,
    maxVersions,
    impl: {
      health: async () => ({ initialized: true, sealed: false, standby: false, version: "1.0.0" }),
      loginKubernetes: async () => ({ clientToken: "hvs.kube", leaseDurationSec: 3600, renewable: true }),
      renewSelf: async () => ({ leaseDurationSec: 3600, renewable: true }),
      lookupSelf: async () => ({ leaseDurationSec: 3600, renewable: true, policies: ["default", "paperclip-default"] }),
      capabilitiesSelf: async (paths) => Object.fromEntries(paths.map((p) => [p, ["create", "read", "update", "delete"]])),
      readMount: async () => ({ type: "kv", options: { version: "2" } }),
      putKv: async ({ mount, path, data, cas }) => {
        const key = `${mount}/${path}`;
        const entry = store.get(key) ?? { versions: [] };
        if (cas !== undefined && cas !== entry.versions.length) {
          throw new SecretProviderClientError({
            code: "conflict",
            provider: "vault",
            operation: "putKv",
            message: "cas mismatch",
          });
        }
        entry.versions.push([JSON.stringify(data)]);
        store.set(key, entry);
        return { version: entry.versions.length };
      },
      getKv: async ({ mount, path, version }) => {
        const key = `${mount}/${path}`;
        const entry = store.get(key);
        if (!entry) {
          throw new SecretProviderClientError({
            code: "not_found",
            provider: "vault",
            operation: "getKv",
            message: "path not found",
          });
        }
        const idx = version === undefined ? entry.versions.length - 1 : version - 1;
        if (idx < 0 || idx >= entry.versions.length) {
          throw new SecretProviderClientError({
            code: "not_found",
            provider: "vault",
            operation: "getKv",
            message: "version not found",
          });
        }
        return { data: JSON.parse(entry.versions[idx][0]), version: idx + 1 };
      },
      setKvMetadata: async ({ mount, path, maxVersions: m }) => {
        maxVersions.set(`${mount}/${path}`, m);
      },
      deleteKv: async ({ mount, path }) => {
        store.delete(`${mount}/${path}`);
      },
    },
  };
}

describe("createSecret", () => {
  const previousEnv = {
    VAULT_TOKEN: process.env.VAULT_TOKEN,
    PAPERCLIP_DEPLOYMENT_ID: process.env.PAPERCLIP_DEPLOYMENT_ID,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("writes the value under the managed KV path and sets max_versions", async () => {
    const gw = fakeVaultGateway();
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 7,
      },
      gateway: gw.impl,
    });
    // token mode picks up VAULT_TOKEN
    process.env.VAULT_TOKEN = "static";

    const result = await provider.createSecret({
      value: "supersecret",
      context: {
        companyId: "co-1",
        deploymentId: "prod-eu1",
        secretId: "sec-1",
        secretKey: "GH_TOKEN",
        secretName: "GitHub Token",
        version: 1,
      } as never,
    });

    expect(result.externalRef).toBe("secret/paperclip/prod-eu1/co-1/GH_TOKEN");
    expect(result.providerVersionRef).toBe("1");
    expect((result.material as { scheme: string }).scheme).toBe("vault_kv_v2");

    const stored = gw.store.get("secret/paperclip/prod-eu1/co-1/GH_TOKEN");
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!.versions[0][0])).toEqual({ value: "supersecret" });
    expect(gw.maxVersions.get("secret/paperclip/prod-eu1/co-1/GH_TOKEN")).toBe(7);
  });

  it("does not store plaintext in returned material", async () => {
    const gw = fakeVaultGateway();
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    const result = await provider.createSecret({
      value: "supersecret",
      context: { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 1 } as never,
    });
    expect(JSON.stringify(result.material)).not.toContain("supersecret");
  });
});

describe("withVaultTokenRetry", () => {
  function tokenMgr(source: VaultAuthSource) {
    return {
      acquire: vi.fn(async () => "tok"),
      invalidate: vi.fn(),
      source,
    } as unknown as VaultTokenManager & { invalidate: ReturnType<typeof vi.fn> };
  }

  it("returns the operation result when no error", async () => {
    const tm = tokenMgr({ mode: "token", token: "x" });
    const r = await withVaultTokenRetry({
      tokenManager: tm,
      sourceMode: "token",
      operation: async () => 42,
    });
    expect(r).toBe(42);
  });

  it("retries once on 403 in kubernetes mode", async () => {
    const tm = tokenMgr({ mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" });
    let calls = 0;
    const r = await withVaultTokenRetry({
      tokenManager: tm,
      sourceMode: "kubernetes",
      operation: async () => {
        calls += 1;
        if (calls === 1) {
          throw new SecretProviderClientError({
            code: "access_denied",
            provider: "vault",
            operation: "kvRead",
            message: "permission denied",
          });
        }
        return "ok";
      },
    });
    expect(r).toBe("ok");
    expect(tm.invalidate).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("does not retry on 403 in token mode", async () => {
    const tm = tokenMgr({ mode: "token", token: "x" });
    let calls = 0;
    await expect(
      withVaultTokenRetry({
        tokenManager: tm,
        sourceMode: "token",
        operation: async () => {
          calls += 1;
          throw new SecretProviderClientError({
            code: "access_denied",
            provider: "vault",
            operation: "kvRead",
            message: "denied",
          });
        },
      }),
    ).rejects.toThrow(/denied/);
    expect(calls).toBe(1);
  });

  it("does not retry on non-403 errors", async () => {
    const tm = tokenMgr({ mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" });
    let calls = 0;
    await expect(
      withVaultTokenRetry({
        tokenManager: tm,
        sourceMode: "kubernetes",
        operation: async () => {
          calls += 1;
          throw new SecretProviderClientError({
            code: "throttled",
            provider: "vault",
            operation: "kvRead",
            message: "slow down",
          });
        },
      }),
    ).rejects.toThrow(/slow down/);
    expect(calls).toBe(1);
  });
});

describe("createVersion", () => {
  it("rotates with CAS = currentVersion and stores under same path", async () => {
    const gw = fakeVaultGateway();
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";

    const ctx = { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 1 } as const;
    await provider.createSecret({ value: "v1", context: ctx });
    const v2 = await provider.createVersion({
      value: "v2",
      context: ctx,
      externalRef: "secret/paperclip/d/co/K",
    });
    expect(v2.providerVersionRef).toBe("2");

    const stored = gw.store.get("secret/paperclip/d/co/K");
    expect(stored!.versions.length).toBe(2);
    expect(JSON.parse(stored!.versions[1][0])).toEqual({ value: "v2" });
  });

  it("maps CAS mismatch to SecretProviderClientError(code:conflict)", async () => {
    const gw = fakeVaultGateway();
    // pre-seed two versions so the CAS check in fakeVaultGateway will reject our cas=1 update
    gw.store.set("secret/paperclip/d/co/K", {
      versions: [[JSON.stringify({ value: "v1" })], [JSON.stringify({ value: "v2-extra" })]],
    });
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: {
        ...gw.impl,
        putKv: async (input) => {
          if (input.cas !== undefined && input.cas === 1) {
            throw new SecretProviderClientError({
              code: "conflict",
              provider: "vault",
              operation: "putKv",
              message: "cas mismatch",
            });
          }
          return gw.impl.putKv(input);
        },
      },
    });
    process.env.VAULT_TOKEN = "static";

    await expect(
      provider.createVersion({
        value: "v3",
        context: { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 1 },
        externalRef: "secret/paperclip/d/co/K",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("VaultTokenManager.sourceMode", () => {
  it("exposes the source mode for retry-helper callers", () => {
    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" },
      gateway: { loginKubernetes: vi.fn(), renewSelf: vi.fn() } as never,
      now: () => 0,
    });
    expect(tm.sourceMode).toBe("kubernetes");
  });
});

describe("resolveVersion — managed", () => {
  async function seedTwoVersions() {
    const gw = fakeVaultGateway();
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    const ctx = { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 1 } as const;
    const v1 = await provider.createSecret({ value: "v1-val", context: ctx });
    const v2 = await provider.createVersion({ value: "v2-val", context: ctx, externalRef: v1.externalRef });
    return { provider, gw, v1, v2 };
  }

  it("resolves the latest version when no providerVersionRef given", async () => {
    const { provider, v2 } = await seedTwoVersions();
    const plaintext = await provider.resolveVersion({
      material: v2.material,
      externalRef: v2.externalRef,
      context: { companyId: "co", secretId: "s", secretKey: "K", version: 2 },
    });
    expect(plaintext).toBe("v2-val");
  });

  it("resolves a pinned version by providerVersionRef", async () => {
    const { provider, v1 } = await seedTwoVersions();
    const plaintext = await provider.resolveVersion({
      material: v1.material,
      externalRef: v1.externalRef,
      providerVersionRef: "1",
      context: { companyId: "co", secretId: "s", secretKey: "K", version: 1 },
    });
    expect(plaintext).toBe("v1-val");
  });

  it("returns not_found error for missing version", async () => {
    const { provider, v1 } = await seedTwoVersions();
    await expect(
      provider.resolveVersion({
        material: v1.material,
        externalRef: v1.externalRef,
        providerVersionRef: "99",
        context: { companyId: "co", secretId: "s", secretKey: "K", version: 99 },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("linkExternalSecret", () => {
  it("returns external_reference material with fingerprint and no plaintext copy", async () => {
    const gw = fakeVaultGateway();
    gw.store.set("secret/external/teams/platform/github", {
      versions: [[JSON.stringify({ value: "external-v1" })]],
    });
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    const linked = await provider.linkExternalSecret({
      externalRef: "secret/external/teams/platform/github",
    });
    expect((linked.material as { source: string }).source).toBe("external_reference");
    expect(linked.externalRef).toBe("secret/external/teams/platform/github");
    expect(JSON.stringify(linked)).not.toContain("external-v1");
    expect(linked.fingerprintSha256).toBeTruthy();
  });

  it("rejects external refs that overlap the managed kvPathPrefix", async () => {
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: fakeVaultGateway().impl,
    });
    process.env.VAULT_TOKEN = "static";
    await expect(
      provider.linkExternalSecret({ externalRef: "secret/paperclip/d/co/SOMETHING" }),
    ).rejects.toThrow(/managed/);
  });
});

describe("resolveVersion — external", () => {
  it("reads the requested dataKey", async () => {
    const gw = fakeVaultGateway();
    gw.store.set("secret/external/multi", {
      versions: [[JSON.stringify({ value: "v", token: "tok-extra" })]],
    });
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    const linked = await provider.linkExternalSecret({
      externalRef: "secret/external/multi#token",
    });
    const plaintext = await provider.resolveVersion({
      material: linked.material,
      externalRef: linked.externalRef,
      context: { companyId: "co", secretId: "s", secretKey: "K", version: 1 },
    });
    expect(plaintext).toBe("tok-extra");
  });
});

describe("healthCheck", () => {
  function gwWith(over: Partial<import("../secrets/vault-provider.js").VaultHttpGateway>): import("../secrets/vault-provider.js").VaultHttpGateway {
    const base = fakeVaultGateway().impl;
    return { ...base, ...over };
  }

  it("status=ok when all probes succeed", async () => {
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gwWith({}),
    });
    process.env.VAULT_TOKEN = "static";
    const r = await provider.healthCheck();
    expect(r.status).toBe("ok");
  });

  it("status=warn when KV mount is v1", async () => {
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gwWith({
        readMount: async () => ({ type: "kv", options: { version: "1" } }),
      }),
    });
    process.env.VAULT_TOKEN = "static";
    const r = await provider.healthCheck();
    expect(r.status).toBe("warn");
    expect(r.message + (r.warnings ?? []).join(" ")).toMatch(/kv v2/i);
  });

  it("status=warn when sys/health reports sealed", async () => {
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gwWith({
        health: async () => ({ sealed: true, standby: false, version: "1.0.0" }),
      }),
    });
    process.env.VAULT_TOKEN = "static";
    const r = await provider.healthCheck();
    expect(r.status).toBe("warn");
    expect((r.warnings ?? []).join(" ") + r.message).toMatch(/sealed/);
  });

  it("status=error when /sys/health is unreachable", async () => {
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gwWith({
        health: async () => { throw new Error("ECONNREFUSED"); },
      }),
    });
    process.env.VAULT_TOKEN = "static";
    const r = await provider.healthCheck();
    expect(r.status).toBe("error");
  });

  it("never includes the token in the response", async () => {
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gwWith({}),
    });
    process.env.VAULT_TOKEN = "hvs.SECRET_SHOULD_NOT_LEAK";
    const r = await provider.healthCheck();
    expect(JSON.stringify(r)).not.toContain("hvs.SECRET_SHOULD_NOT_LEAK");
  });
});

describe("deleteOrArchive", () => {
  it("soft-deletes the KV path in delete mode", async () => {
    const gw = fakeVaultGateway();
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    const ctx = { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 1 } as const;
    const created = await provider.createSecret({ value: "x", context: ctx });
    await provider.deleteOrArchive({
      material: created.material,
      externalRef: created.externalRef,
      context: ctx,
      mode: "delete",
    });
    expect(gw.store.get("secret/paperclip/d/co/K")).toBeUndefined();
  });

  it("is a no-op for external_reference material", async () => {
    const gw = fakeVaultGateway();
    gw.store.set("secret/external/path", { versions: [[JSON.stringify({ value: "x" })]] });
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    const linked = await provider.linkExternalSecret({ externalRef: "secret/external/path" });
    await provider.deleteOrArchive({
      material: linked.material,
      externalRef: linked.externalRef,
      mode: "delete",
    });
    expect(gw.store.get("secret/external/path")).toBeTruthy();
  });

  it("archive mode is a no-op (vault KV v2 versioning is implicit)", async () => {
    const gw = fakeVaultGateway();
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    const ctx = { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 1 } as const;
    const created = await provider.createSecret({ value: "x", context: ctx });
    await provider.deleteOrArchive({
      material: created.material,
      externalRef: created.externalRef,
      context: ctx,
      mode: "archive",
    });
    expect(gw.store.get("secret/paperclip/d/co/K")).toBeTruthy();
  });
});
