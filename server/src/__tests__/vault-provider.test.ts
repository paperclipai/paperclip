import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVaultProvider,
  detectVaultAuthSource,
  resolveVaultConfig,
  type VaultAuthSource,
} from "../secrets/vault-provider.js";

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
