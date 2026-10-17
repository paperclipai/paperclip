import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedKvPath,
  createVaultProvider,
  detectVaultAuthSource,
  HttpVaultGateway,
  parseExternalRef,
  resolveVaultConfig,
  VaultTokenManager,
  withVaultTokenRetry,
  type VaultAuthSource,
  type VaultHttpGateway,
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

  it("rejects a namespace with control characters", async () => {
    const r = await check({ namespace: "bad\r\nns" });
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/namespace/);
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

  it("resolves auth.method=approle from env without requiring a role", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://vault.env:8200",
        PAPERCLIP_SECRETS_VAULT_AUTH_METHOD: "approle",
      },
      providerConfig: null,
    });
    expect(r.config?.auth.method).toBe("approle");
    expect(r.config?.auth.role).toBeNull();
  });

  it("operator env address wins over a per-vault config address, warning on the redirect", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://from-env:8200" },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://from-config:8200" },
      },
    });
    expect(r.config?.address).toBe("https://from-env:8200");
    expect(r.warnings.join(" ")).toMatch(/overridden by the operator/i);
  });

  it("accepts a per-vault config address that restates the operator env address without warning", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://same-vault:8200" },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://same-vault:8200" },
      },
    });
    expect(r.config?.address).toBe("https://same-vault:8200");
    expect(r.warnings).toHaveLength(0);
  });

  it("ignores the per-vault config address when no operator pin is set (no opt-in)", () => {
    const r = resolveVaultConfig({
      env: {},
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://from-config:8200" },
      },
    });
    // No operator pin + no ALLOW_CONFIG_ADDR: the company address must not be
    // used as the credential endpoint.
    expect(r.config).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/operator-pinned/i);
  });

  it("uses the per-vault config address when the operator opts in (ALLOW_CONFIG_ADDR=1)", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR: "1" },
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

  it("falls back to the standard VAULT_ADDR env when PAPERCLIP_SECRETS_VAULT_ADDR is unset", () => {
    const r = resolveVaultConfig({
      env: { VAULT_ADDR: "https://orchestrator-vault:8200" },
      providerConfig: null,
    });
    expect(r.config?.address).toBe("https://orchestrator-vault:8200");
  });

  it("prefers PAPERCLIP_SECRETS_VAULT_ADDR over the standard VAULT_ADDR", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://paperclip-vault:8200",
        VAULT_ADDR: "https://orchestrator-vault:8200",
      },
      providerConfig: null,
    });
    expect(r.config?.address).toBe("https://paperclip-vault:8200");
  });

  // --- saTokenPath is a file the server reads and sends as the k8s login JWT, ---
  // --- so a company config choosing a custom path is an information-disclosure  ---
  // --- primitive. Operator pins win; a config custom path needs the opt-in.     ---
  it("ignores a custom config saTokenPath when no operator pin is set and no opt-in", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_K8S_ROLE: "paperclip-server",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "paperclip-server", saTokenPath: "/etc/hostname" },
        },
      },
    });
    expect(r.config?.auth.method).toBe("kubernetes");
    // Custom path is ignored; the in-cluster default is used.
    expect(r.config?.auth.saTokenPath).toBe(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    );
    expect(r.warnings.join(" ")).toMatch(/saTokenPath is ignored/i);
  });

  it("honors a custom config saTokenPath when the operator opts in (ALLOW_CONFIG_ADDR=1)", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR: "1",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "paperclip-server", saTokenPath: "/custom/jwt" },
        },
      },
    });
    expect(r.config?.auth.saTokenPath).toBe("/custom/jwt");
    expect(r.warnings).toHaveLength(0);
  });

  it("operator-pinned PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH wins over a config saTokenPath", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_K8S_ROLE: "paperclip-server",
        PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH: "/operator/jwt",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "paperclip-server", saTokenPath: "/custom/jwt" },
        },
      },
    });
    expect(r.config?.auth.saTokenPath).toBe("/operator/jwt");
    expect(r.warnings.join(" ")).toMatch(/saTokenPath is overridden by the operator/i);
  });

  it("does not warn when a config saTokenPath restates the operator pin", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_K8S_ROLE: "paperclip-server",
        PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH: "/operator/jwt",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "paperclip-server", saTokenPath: "/operator/jwt" },
        },
      },
    });
    expect(r.config?.auth.saTokenPath).toBe("/operator/jwt");
    expect(r.warnings).toHaveLength(0);
  });

  // --- The kubernetes role selects which Vault auth role the server login  ---
  // --- authenticates against; different roles carry different policies, so ---
  // --- a company writer must not swap the deployment into a broader role.  ---
  it("operator-pinned PAPERCLIP_SECRETS_VAULT_K8S_ROLE wins over a config auth.role", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_K8S_ROLE: "paperclip-server",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "attacker-role" },
        },
      },
    });
    expect(r.config?.auth.role).toBe("paperclip-server");
    expect(r.warnings.join(" ")).toMatch(/auth.role is overridden by the operator/i);
  });

  it("does not warn when a config auth.role restates the operator pin", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_K8S_ROLE: "paperclip-server",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "paperclip-server" },
        },
      },
    });
    expect(r.config?.auth.role).toBe("paperclip-server");
    expect(r.warnings).toHaveLength(0);
  });

  it("honors a config auth.role when the operator opts in (ALLOW_CONFIG_ADDR=1)", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR: "1",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "custom-role" },
        },
      },
    });
    expect(r.config?.auth.role).toBe("custom-role");
    expect(r.warnings).toHaveLength(0);
  });

  it("fails closed when a config auth.role has no operator pin and no opt-in", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200" },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: {
          address: "https://v:8200",
          auth: { method: "kubernetes", role: "attacker-role" },
        },
      },
    });
    expect(r.config).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/auth.role is ignored/i);
  });

  it("operator env kvMount wins over a per-vault config mountPath, warning on the redirect", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200", PAPERCLIP_SECRETS_VAULT_KV_MOUNT: "op-mount" },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://v:8200", mountPath: "attacker-mount" },
      },
    });
    expect(r.config?.kvMount).toBe("op-mount");
    expect(r.warnings.join(" ")).toMatch(/mountPath is overridden by the operator/i);
  });

  it("ignores a per-vault config kvPathPrefix when no operator pin is set (no opt-in)", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200" },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://v:8200", secretPathPrefix: "attacker-prefix" },
      },
    });
    expect(r.config?.kvPathPrefix).toBe("paperclip");
    expect(r.warnings.join(" ")).toMatch(/secretPathPrefix is ignored/i);
  });

  it("honors a per-vault config kvMount when the operator opts in (ALLOW_CONFIG_ADDR=1)", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200", PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR: "1" },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://v:8200", mountPath: "custom-mount" },
      },
    });
    expect(r.config?.kvMount).toBe("custom-mount");
  });

  it("operator env namespace wins over a per-vault config namespace", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_NAMESPACE: "op/ns",
      },
      providerConfig: {
        id: "v1",
        provider: "vault",
        status: "ready",
        config: { address: "https://v:8200", namespace: "company/ns" },
      },
    });
    expect(r.config?.namespace).toBe("op/ns");
    expect(r.warnings.join(" ")).toMatch(/namespace is overridden by the operator/i);
  });

  it("rejects a namespace with control characters", () => {
    const r = resolveVaultConfig({
      env: { PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200", PAPERCLIP_SECRETS_VAULT_NAMESPACE: "bad\r\nns" },
      providerConfig: null,
    });
    expect(r.warnings.join(" ")).toMatch(/namespace/i);
    // A supplied-but-invalid namespace must not silently fall back to root:
    // the gateway would omit x-vault-namespace and target root. Fail closed.
    expect(r.config).toBeNull();
  });

  it("rejects a kvPathPrefix containing a '..' segment", () => {
    const rr = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX: "a/../b",
      },
      providerConfig: null,
    });
    expect(rr.config).toBeNull();
    expect(rr.warnings.join(" ")).toMatch(/must not contain '\.' or '\.\.'/);
  });

  it("rejects a kvPathPrefix with a trailing slash or '//'", () => {
    const rr = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v:8200",
        PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX: "paperclip/",
      },
      providerConfig: null,
    });
    expect(rr.config).toBeNull();
    expect(rr.warnings.join(" ")).toMatch(/must not end with '\/' or contain '\/\//);
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

  it("returns token mode with a tokenPath when only PAPERCLIP_SECRETS_VAULT_TOKEN_FILE is set", () => {
    const r = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      env: { PAPERCLIP_SECRETS_VAULT_TOKEN_FILE: "/run/vault/token" },
      readSaToken: () => null,
    });
    expect(r.mode).toBe("token");
    if (r.mode === "token") {
      expect(r.token).toBe("");
      expect(r.tokenPath).toBe("/run/vault/token");
    }
  });

  it("returns approle mode when role_id and secret_id env are set", () => {
    const r = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "approle", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      env: {
        PAPERCLIP_SECRETS_VAULT_APPROLE_ROLE_ID: "role-123",
        PAPERCLIP_SECRETS_VAULT_APPROLE_SECRET_ID: "secret-456",
      },
      readSaToken: () => null,
    });
    expect(r.mode).toBe("approle");
    if (r.mode === "approle") {
      expect(r.roleId).toBe("role-123");
      expect(r.secretId).toBe("secret-456");
      expect(r.roleIdPath).toBeUndefined();
      expect(r.secretIdPath).toBeUndefined();
    }
  });

  it("returns approle mode with file paths when only *_FILE env are set", () => {
    const r = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "approle", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      env: {
        PAPERCLIP_SECRETS_VAULT_APPROLE_ROLE_ID_FILE: "/run/vault/role-id",
        PAPERCLIP_SECRETS_VAULT_APPROLE_SECRET_ID_FILE: "/run/vault/secret-id",
      },
      readSaToken: () => null,
    });
    expect(r.mode).toBe("approle");
    if (r.mode === "approle") {
      expect(r.roleId).toBe("");
      expect(r.secretId).toBe("");
      expect(r.roleIdPath).toBe("/run/vault/role-id");
      expect(r.secretIdPath).toBe("/run/vault/secret-id");
    }
  });

  it("returns error when approle role_id or secret_id is missing", () => {
    const r = detectVaultAuthSource({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "approle", role: null, saTokenPath: "/dev/null" },
        versionRetention: 10,
      },
      env: { PAPERCLIP_SECRETS_VAULT_APPROLE_ROLE_ID: "role-123" },
      readSaToken: () => null,
    });
    expect(r.mode).toBe("error");
    if (r.mode === "error") expect(r.message).toMatch(/approle/i);
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

  it("rejects a '.' or '..' segment so a key like '..' cannot escape the managed prefix", () => {
    const config = {
      address: "https://v",
      namespace: null,
      kvMount: "secret",
      kvPathPrefix: "paperclip",
      auth: { method: "token" as const, role: null, saTokenPath: "/dev/null" },
      versionRetention: 10,
    };
    expect(() =>
      buildManagedKvPath({ config, deploymentId: "d", companyId: "c", secretKey: ".." }),
    ).toThrow(/must not be '\.' or '\.\.'/);
    expect(() =>
      buildManagedKvPath({ config, deploymentId: ".", companyId: "c", secretKey: "k" }),
    ).toThrow(/must not be '\.' or '\.\.'/);
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

  it("rejects path segments containing '?' (would inject URL query string)", () => {
    expect(() => parseExternalRef("secret/teams?cap=create/key")).toThrow(
      /path segments must match/,
    );
  });

  it("rejects path segments containing '&' (would inject extra query params)", () => {
    expect(() => parseExternalRef("secret/teams&cap=create/key")).toThrow(
      /path segments must match/,
    );
  });

  it("rejects path segments containing whitespace", () => {
    expect(() => parseExternalRef("secret/teams platform/key")).toThrow(
      /path segments must match/,
    );
  });

  it("rejects path segments containing '%' (would smuggle URL-encoded bytes)", () => {
    expect(() => parseExternalRef("secret/teams/key%2fadmin")).toThrow(
      /path segments must match/,
    );
  });

  it("accepts multi-segment refs whose every segment matches the safe character class", () => {
    const r = parseExternalRef("secret/teams/platform/sub.team_v1/key-name");
    expect(r).toEqual({
      mount: "secret",
      path: "teams/platform/sub.team_v1/key-name",
      dataKey: "value",
    });
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
      loginApprole: vi.fn(async () => ({
        clientToken: "hvs.approle.1",
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

  it("performs initial login on first acquire (approle mode)", async () => {
    const gw = fakeGateway();
    const tm = new VaultTokenManager({
      source: { mode: "approle", roleId: "role-1", secretId: "secret-1" },
      gateway: gw as never,
      now: () => 0,
    });
    expect(await tm.acquire()).toBe("hvs.approle.1");
    expect(gw.loginApprole).toHaveBeenCalledTimes(1);
    expect(gw.loginApprole.mock.calls[0][0]).toMatchObject({ roleId: "role-1", secretId: "secret-1" });
  });

  it("renews an approle token proactively past the 70% TTL threshold", async () => {
    const gw = fakeGateway();
    let t = 0;
    const tm = new VaultTokenManager({
      source: { mode: "approle", roleId: "role-1", secretId: "secret-1" },
      gateway: gw as never,
      now: () => t,
    });
    await tm.acquire();
    t = 71_000;
    await tm.acquire();
    expect(gw.renewSelf).toHaveBeenCalledTimes(1);
  });

  it("re-reads approle role_id/secret_id files on each login (in-place rotation)", async () => {
    const gw = fakeGateway();
    gw.loginApprole
      .mockResolvedValueOnce({ clientToken: "hvs.approle.1", leaseDurationSec: 100, renewable: false })
      .mockResolvedValueOnce({ clientToken: "hvs.approle.2", leaseDurationSec: 100, renewable: false });

    const files: Record<string, string | null> = {
      "/run/vault/role-id": "role-original",
      "/run/vault/secret-id": "secret-original",
    };
    const readSaToken = vi.fn((path: string) => files[path] ?? null);

    let t = 0;
    const tm = new VaultTokenManager({
      source: {
        mode: "approle",
        roleId: "role-stale",
        secretId: "secret-stale",
        roleIdPath: "/run/vault/role-id",
        secretIdPath: "/run/vault/secret-id",
      },
      gateway: gw as never,
      now: () => t,
      readSaToken,
    });

    await tm.acquire();
    files["/run/vault/role-id"] = "role-rotated";
    files["/run/vault/secret-id"] = "secret-rotated";
    t = 200_000; // force a re-login
    await tm.acquire();

    expect(gw.loginApprole).toHaveBeenCalledTimes(2);
    expect(gw.loginApprole.mock.calls[0][0]).toMatchObject({ roleId: "role-original", secretId: "secret-original" });
    expect(gw.loginApprole.mock.calls[1][0]).toMatchObject({ roleId: "role-rotated", secretId: "secret-rotated" });
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

  it("re-reads the token file on each acquire and falls back to the env token when absent", async () => {
    const gw = { loginKubernetes: vi.fn(), renewSelf: vi.fn() };
    let fileToken: string | null = "hvs.file.1";
    const tm = new VaultTokenManager({
      source: { mode: "token", token: "env-fallback", tokenPath: "/run/vault/token" },
      gateway: gw as never,
      now: () => 0,
      readSaToken: () => fileToken,
    });
    expect(await tm.acquire()).toBe("hvs.file.1"); // read from the file
    fileToken = "hvs.file.2";
    expect(await tm.acquire()).toBe("hvs.file.2"); // rotated file re-read
    fileToken = null;
    expect(await tm.acquire()).toBe("env-fallback"); // file absent -> env token
    expect(gw.loginKubernetes).not.toHaveBeenCalled(); // token mode never logs in
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

  it("re-reads the SA JWT from disk on each login (kubernetes SA token rotation)", async () => {
    // Greptile r3 P1: VaultTokenManager used to capture the SA JWT once at
    // session creation. After the projected SA token rotates on disk and
    // the cached vault token becomes non-renewable, the fallback re-login
    // path would re-send the stale JWT and get a 403 forever.
    const gw = fakeGateway();
    // First login renewable=false so the renewal path is skipped on second
    // acquire and we go straight back through loginKubernetes.
    gw.loginKubernetes
      .mockResolvedValueOnce({ clientToken: "hvs.kube.1", leaseDurationSec: 100, renewable: false })
      .mockResolvedValueOnce({ clientToken: "hvs.kube.2", leaseDurationSec: 100, renewable: false });

    const reads: string[] = [];
    const jwts = ["jwt-original", "jwt-rotated"];
    const readSaToken = vi.fn((path: string) => {
      reads.push(path);
      return jwts.shift() ?? null;
    });

    let t = 0;
    const tm = new VaultTokenManager({
      // The cached jwt on the source is "jwt-stale" — what was captured
      // at session creation. If the fix is missing, the second login will
      // re-send "jwt-stale". With the fix, readSaToken is consulted and
      // the rotated value goes out instead.
      source: { mode: "kubernetes", role: "r", jwt: "jwt-stale", saTokenPath: "/var/run/sa" },
      gateway: gw as never,
      now: () => t,
      readSaToken,
    });

    await tm.acquire();
    // jump past the (1 - skew) renewal point so a re-login is required
    t = 200_000;
    await tm.acquire();

    expect(gw.loginKubernetes).toHaveBeenCalledTimes(2);
    // Login 1 used the freshly-read jwt-original (NOT the cached "jwt-stale")
    expect(gw.loginKubernetes.mock.calls[0][0]).toMatchObject({ jwt: "jwt-original" });
    // Login 2 used the rotated jwt picked up from disk on this second login
    expect(gw.loginKubernetes.mock.calls[1][0]).toMatchObject({ jwt: "jwt-rotated" });
    expect(readSaToken).toHaveBeenCalledWith("/var/run/sa");
  });

  it("falls back to the cached source.jwt when the SA token file is unreadable", async () => {
    const gw = fakeGateway();
    const readSaToken = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    // Silence the expected warn log so test output stays clean and assert
    // the structured logger (not console.error) carries the message —
    // greptile r5 P2 moved this off console.error to the pino logger so
    // it shows up in operators' log aggregators.
    const { logger } = await import("../middleware/logger.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "jwt-cached", saTokenPath: "/var/run/sa" },
      gateway: gw as never,
      now: () => 0,
      readSaToken,
    });
    await tm.acquire();

    expect(gw.loginKubernetes).toHaveBeenCalledTimes(1);
    expect(gw.loginKubernetes.mock.calls[0][0]).toMatchObject({ jwt: "jwt-cached" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatchObject({ saTokenPath: "/var/run/sa" });
    warnSpy.mockRestore();
  });

  it("treats tokens within TOKEN_EXPIRY_SKEW_MS of the renewal threshold as renewable (clock-skew guard)", async () => {
    // The renewal threshold is (ttlMs * 0.7 - TOKEN_EXPIRY_SKEW_MS).
    // For a 100s TTL, that's 70_000 - 30_000 = 40_000ms.
    // At t=45s a token without the skew guard would still be inside the
    // 70% window and served as-is; with the guard, renewSelf must fire.
    const gw = fakeGateway();
    let t = 0;
    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" },
      gateway: gw as never,
      now: () => t,
    });
    await tm.acquire();           // ttl=100s captured at t=0
    expect(gw.loginKubernetes).toHaveBeenCalledTimes(1);

    t = 45_000;                    // past 40_000 (= 0.7*100s - 30s) but before 70_000 (naive 70%)
    await tm.acquire();
    expect(gw.renewSelf).toHaveBeenCalledTimes(1);
  });

  it("with TOKEN_EXPIRY_SKEW_MS guard, a token at t=39s is still cached (just under the skewed threshold)", async () => {
    const gw = fakeGateway();
    let t = 0;
    const tm = new VaultTokenManager({
      source: { mode: "kubernetes", role: "r", jwt: "j", saTokenPath: "/sa" },
      gateway: gw as never,
      now: () => t,
    });
    await tm.acquire();
    t = 39_000;                    // just under 40_000 — cached token is reused
    await tm.acquire();
    expect(gw.renewSelf).not.toHaveBeenCalled();
    expect(gw.loginKubernetes).toHaveBeenCalledTimes(1);
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
      loginApprole: async () => ({ clientToken: "hvs.approle", leaseDurationSec: 3600, renewable: true }),
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

  it("treats a create-only CAS conflict as a lost-response replay (does not write a second version)", async () => {
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
    process.env.VAULT_TOKEN = "static";
    // Simulate a previous create that already wrote version 1 with the SAME
    // value (a lost-response retry). A second createSecret must not write a
    // second version.
    const key = "secret/paperclip/prod-eu1/co-1/GH_TOKEN";
    gw.store.set(key, { versions: [[JSON.stringify({ value: "supersecret" })]] });

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

    // Re-read the existing version instead of advancing it.
    expect(result.providerVersionRef).toBe("1");
    expect(gw.store.get(key)!.versions).toHaveLength(1);
    expect(JSON.parse(gw.store.get(key)!.versions[0]![0])).toEqual({ value: "supersecret" });
  });

  it("rejects a create-only CAS conflict when the existing entry holds a different value (rename-then-recreate)", async () => {
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
    process.env.VAULT_TOKEN = "static";
    // A previous secret already owns this path (value "oldvalue"). A NEW secret
    // created under the now-free key must not silently adopt that version — it
    // would resolve to the old secret's value.
    const key = "secret/paperclip/prod-eu1/co-1/GH_TOKEN";
    gw.store.set(key, { versions: [[JSON.stringify({ value: "oldvalue" })]] });

    await expect(
      provider.createSecret({
        value: "supersecret",
        context: {
          companyId: "co-1",
          deploymentId: "prod-eu1",
          secretId: "sec-1",
          secretKey: "GH_TOKEN",
          secretName: "GitHub Token",
          version: 1,
        } as never,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: /already holds a different value/,
    });
    // The colliding value must not have been overwritten.
    expect(gw.store.get(key)!.versions).toHaveLength(1);
  });

  it("rethrows a genuine create 400 when the entry does not actually exist", async () => {
    const gw = fakeVaultGateway();
    // putKv throws a conflict even though nothing exists (a real 400, not a
    // CAS replay). createSecret must surface it rather than swallow it.
    const origPutKv = gw.impl.putKv.bind(gw.impl);
    gw.impl.putKv = async (input) => {
      throw new SecretProviderClientError({
        code: "conflict",
        provider: "vault",
        operation: "putKv",
        message: "real 400",
      });
    };
    void origPutKv;
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
    process.env.VAULT_TOKEN = "static";
    await expect(
      provider.createSecret({
        value: "supersecret",
        context: {
          companyId: "co-1",
          deploymentId: "prod-eu1",
          secretId: "sec-1",
          secretKey: "GH_TOKEN",
          secretName: "GitHub Token",
          version: 1,
        } as never,
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "real 400" });
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

  it("retries once on 403 in approle mode", async () => {
    const tm = tokenMgr({ mode: "approle", roleId: "r", secretId: "s" });
    let calls = 0;
    const r = await withVaultTokenRetry({
      tokenManager: tm,
      sourceMode: "approle",
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
    const seenCas: (number | undefined)[] = [];
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
          seenCas.push(input.cas);
          return gw.impl.putKv(input);
        },
      },
    });
    process.env.VAULT_TOKEN = "static";

    // The service passes `version: nextVersion` (latestVersion + 1) in the
    // write context, mirroring the real rotate path.
    const ctx = { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 2 } as const;
    await provider.createSecret({ value: "v1", context: { ...ctx, version: 1 } });
    const v2 = await provider.createVersion({
      value: "v2",
      context: ctx,
      externalRef: "secret/paperclip/d/co/K",
    });
    expect(v2.providerVersionRef).toBe("2");
    // The first write is createSecret, which now uses cas: 0 (create-only) so
    // a lost-response retry cannot write a second version. The rotation uses
    // CAS = the CURRENT stored version (1), not the next Paperclip version (2)
    // — the first rotation previously sent cas:2 against a one-version key and
    // got a spurious conflict.
    expect(seenCas).toEqual([0, 1]);

    const stored = gw.store.get("secret/paperclip/d/co/K");
    expect(stored!.versions.length).toBe(2);
    expect(JSON.parse(stored!.versions[1][0])).toEqual({ value: "v2" });
  });

  it("rotates the stored path, not a rebuilt path, after the secret is renamed", async () => {
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

    const original = { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "OLD", secretName: "OLD", version: 2 } as const;
    const created = await provider.createSecret({ value: "v1", context: { ...original, version: 1 } });
    expect(created.externalRef).toBe("secret/paperclip/d/co/OLD");

    // Secret key renamed OLD -> NEW; the recorded externalRef still points at
    // the OLD path where the value lives. Rotation must write there.
    const renamedCtx = { ...original, secretKey: "NEW", secretName: "NEW" } as const;
    const v2 = await provider.createVersion({
      value: "v2",
      context: renamedCtx,
      externalRef: created.externalRef,
    });
    expect(v2.providerVersionRef).toBe("2");
    expect(gw.store.get("secret/paperclip/d/co/OLD")!.versions.length).toBe(2);
    // A path rebuilt from the NEW key must not have been created.
    expect(gw.store.has("secret/paperclip/d/co/NEW")).toBe(false);
  });

  it("rejects rotating a reference outside the managed prefix (external_reference secret)", async () => {
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
    const ctx = { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 2 } as const;
    // An external_reference secret's ref lives outside the managed prefix; it
    // is rotated via linkExternalSecret, not createVersion.
    await expect(
      provider.createVersion({
        value: "v2",
        context: ctx,
        externalRef: "teams/platform/github-token",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: /outside the managed prefix/,
    });
  });

  it("self-heals a CAS mismatch by writing on top of the current version (lost-response/desync recovery)", async () => {
    const gw = fakeVaultGateway();
    // Pre-seed three versions so the fake gateway's CAS check rejects cas=2
    // (the current stored version is 3). The service-shaped context is
    // `version: 3` (next) -> cas 2, which is now stale: a prior rotate's write
    // committed but its response/DB step was lost, leaving Vault one ahead.
    gw.store.set("secret/paperclip/d/co/K", {
      versions: [
        [JSON.stringify({ value: "v1" })],
        [JSON.stringify({ value: "v2" })],
        [JSON.stringify({ value: "v2-extra" })],
      ],
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

    const result = await provider.createVersion({
      value: "v3",
      context: {
        companyId: "co",
        deploymentId: "d",
        secretId: "s",
        secretKey: "K",
        secretName: "K",
        version: 3,
      },
      externalRef: "secret/paperclip/d/co/K",
    });
    // Self-heal: re-read the actual current version (3), then write on top with
    // cas=3 -> version 4. Rotation must not brick permanently on a lost write.
    expect(result.providerVersionRef).toBe("4");
    const stored = gw.store.get("secret/paperclip/d/co/K")!;
    expect(stored.versions).toHaveLength(4);
    expect(JSON.parse(stored.versions[3][0])).toEqual({ value: "v3" });
  });

  it("adopts the existing version on a CAS conflict when it already holds the intended value (idempotent replay)", async () => {
    const gw = fakeVaultGateway();
    // A lost-response rotate already wrote version 2 = "v2"; the retry must
    // adopt it rather than writing a third version.
    gw.store.set("secret/paperclip/d/co/K", {
      versions: [
        [JSON.stringify({ value: "v1" })],
        [JSON.stringify({ value: "v2" })],
      ],
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

    const result = await provider.createVersion({
      value: "v2",
      context: {
        companyId: "co",
        deploymentId: "d",
        secretId: "s",
        secretKey: "K",
        secretName: "K",
        version: 2,
      },
      externalRef: "secret/paperclip/d/co/K",
    });
    expect(result.providerVersionRef).toBe("2");
    expect(gw.store.get("secret/paperclip/d/co/K")!.versions).toHaveLength(2);
  });

  it("rethrows a CAS conflict when Vault is more than one ahead with a different value (stale replay must not clobber a newer rotation)", async () => {
    const gw = fakeVaultGateway();
    // Paperclip's latestVersion is 2, so the next version is 3 (cas=2). But a
    // newer rotation has since committed versions 3 AND 4, leaving Vault two
    // ahead of the recorded version. A stale replay of the old value must NOT
    // overwrite the newer committed value; the conflict must propagate.
    gw.store.set("secret/paperclip/d/co/K", {
      versions: [
        [JSON.stringify({ value: "v1" })],
        [JSON.stringify({ value: "v2" })],
        [JSON.stringify({ value: "v3-newer" })],
        [JSON.stringify({ value: "v4-newer" })],
      ],
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

    await expect(
      provider.createVersion({
        value: "v3-stale",
        context: {
          companyId: "co",
          deploymentId: "d",
          secretId: "s",
          secretKey: "K",
          secretName: "K",
          version: 3,
        },
        externalRef: "secret/paperclip/d/co/K",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // No fifth version was written, and the newer committed value is intact.
    const stored = gw.store.get("secret/paperclip/d/co/K")!;
    expect(stored.versions).toHaveLength(4);
    expect(JSON.parse(stored.versions[3][0])).toEqual({ value: "v4-newer" });
  });

  it("applies max_versions on rotation (createVersion refreshes KV metadata)", async () => {
    const gw = fakeVaultGateway();
    // Seed one existing version directly (not via createSecret) so that any
    // max_versions applied below can only have come from createVersion.
    gw.store.set("secret/paperclip/d/co/K", {
      versions: [[JSON.stringify({ value: "v1" })]],
    });
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "token", role: null, saTokenPath: "/dev/null" },
        versionRetention: 25,
      },
      gateway: gw.impl,
    });
    process.env.VAULT_TOKEN = "static";
    await provider.createVersion({
      value: "v2",
      context:
        {
          companyId: "co",
          deploymentId: "d",
          secretId: "s",
          secretKey: "K",
          secretName: "K",
          version: 1,
        } as never,
    });
    // createVersion must have applied the current retention to the key.
    expect(gw.maxVersions.get("secret/paperclip/d/co/K")).toBe(25);
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

  it("rejects an external ref overlapping the deployment-wide prefix even when the provider config relocated its own prefix", async () => {
    // Simulate a company that overrode its own kvMount/kvPathPrefix (operator
    // opted in). The guard must still reject a ref into the deployment-wide
    // managed prefix ("secret"/"paperclip" from env/defaults), because that is
    // where other companies' managed secrets live.
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "attacker-mount",
        kvPathPrefix: "zzz",
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

  it("does not disclose the deployment token's TTL, renewability, policies, or capabilities", async () => {
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
    const details = (r as { details?: Record<string, unknown> }).details ?? {};
    expect(details.tokenTtlSec).toBeUndefined();
    expect(details.tokenRenewable).toBeUndefined();
    expect(details.policies).toBeUndefined();
    expect(details.capabilities).toBeUndefined();
  });

  it("surfaces an ignored company setting as a warning instead of looking healthy", async () => {
    const prev = {
      ADDR: process.env.PAPERCLIP_SECRETS_VAULT_ADDR,
      PREFIX: process.env.PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX,
      ALLOW: process.env.PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR,
      VAULT_TOKEN: process.env.VAULT_TOKEN,
    };
    try {
      // Operator pins the address but not the prefix and does not opt in, so a
      // company-config secretPathPrefix is ignored. That warning must reach
      // the health response rather than being dropped as a "healthy" result.
      process.env.PAPERCLIP_SECRETS_VAULT_ADDR = "https://v:8200";
      delete process.env.PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX;
      delete process.env.PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR;
      process.env.VAULT_TOKEN = "static";
      const provider = createVaultProvider({ gateway: gwWith({}) });
      const r = await provider.healthCheck({
        providerConfig: {
          id: "v1",
          provider: "vault",
          status: "ready",
          config: { address: "https://v:8200", secretPathPrefix: "company/prefix" },
        },
      });
      expect(r.status).toBe("warn");
      expect((r.warnings ?? []).join(" ")).toMatch(/secretPathPrefix is ignored/i);
    } finally {
      if (prev.ADDR === undefined) delete process.env.PAPERCLIP_SECRETS_VAULT_ADDR; else process.env.PAPERCLIP_SECRETS_VAULT_ADDR = prev.ADDR;
      if (prev.PREFIX === undefined) delete process.env.PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX; else process.env.PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX = prev.PREFIX;
      if (prev.ALLOW === undefined) delete process.env.PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR; else process.env.PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR = prev.ALLOW;
      if (prev.VAULT_TOKEN === undefined) delete process.env.VAULT_TOKEN; else process.env.VAULT_TOKEN = prev.VAULT_TOKEN;
    }
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

describe("HttpVaultGateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends X-Vault-Token + X-Vault-Namespace headers on KV reads", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { data: { value: "v" }, metadata: { version: 1 } } }), {
        status: 200,
      }),
    );
    const gateway = new HttpVaultGateway({
      address: "https://vault.example:8200",
      namespace: "ns1",
      getToken: async () => "hvs.kube.1",
    });
    const r = await gateway.getKv({ mount: "secret", path: "paperclip/d/co/K" });
    expect(r).toEqual({ data: { value: "v" }, version: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://vault.example:8200/v1/secret/data/paperclip/d/co/K");
    expect(init).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-vault-token": "hvs.kube.1",
          "x-vault-namespace": "ns1",
        }),
      }),
    );
  });

  it("maps 403 to SecretProviderClientError(code:access_denied)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: ["permission denied"] }), { status: 403 }),
    );
    const gateway = new HttpVaultGateway({
      address: "https://vault.example:8200",
      namespace: null,
      getToken: async () => "hvs.k",
    });
    await expect(gateway.getKv({ mount: "secret", path: "paperclip/d/co/K" })).rejects.toMatchObject({
      code: "access_denied",
    });
  });

  it("maps 404 to not_found, 429 to throttled, 500 to provider_error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [] }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [] }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [] }), { status: 500 }));
    const gateway = new HttpVaultGateway({
      address: "https://vault.example:8200",
      namespace: null,
      getToken: async () => "t",
    });
    await expect(gateway.getKv({ mount: "secret", path: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(gateway.getKv({ mount: "secret", path: "x" })).rejects.toMatchObject({ code: "throttled" });
    await expect(gateway.getKv({ mount: "secret", path: "x" })).rejects.toMatchObject({ code: "provider_error" });
  });

  it("renewSelf uses the supplied token and does not re-enter getToken (deadlock guard)", async () => {
    // Greptile r4 P1: renewSelf used to omit `authenticated: false` and
    // pass nothing to call(), which would await getToken(). When invoked
    // from inside VaultTokenManager.acquireInner, getToken returned the
    // inflight acquireInner promise and the renewal path deadlocked
    // forever. The fix takes the token as an argument and forwards it
    // verbatim, so getToken is never consulted on this path.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ auth: { lease_duration: 900, renewable: true } }), { status: 200 }),
    );
    const getToken = vi.fn(async () => {
      throw new Error("getToken must not be called from renewSelf");
    });
    const gateway = new HttpVaultGateway({
      address: "https://vault.example:8200",
      namespace: null,
      getToken,
    });

    const r = await gateway.renewSelf("explicit-token");
    expect(r).toEqual({ leaseDurationSec: 900, renewable: true });
    expect(getToken).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "x-vault-token": "explicit-token" }),
      }),
    );
  });

  it("bounds a stalled request with a timeout and lets the next request proceed", async () => {
    // A server that accepts the connection but never responds: fetch returns a
    // promise that never settles. The gateway must abandon it at the bounded
    // lifetime (AbortSignal.timeout) instead of pinning the caller, and a
    // later request must succeed once the server responds.
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce((url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init as { signal?: AbortSignal }).signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { data: { value: "v" }, metadata: { version: 1 } } }), { status: 200 }),
      );
    const gateway = new HttpVaultGateway({
      address: "https://vault.example:8200",
      namespace: null,
      getToken: async () => "hvs.kube.1",
      timeoutMs: 25,
    });
    await expect(gateway.getKv({ mount: "secret", path: "p/d/co/K" })).rejects.toThrow();
    const second = await gateway.getKv({ mount: "secret", path: "p/d/co/K" });
    expect(second).toEqual({ data: { value: "v" }, version: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Greptile round-1 regressions", () => {
  it("caches the gateway+tokenManager pair across operations on the same config (kubernetes auth login is only called once)", async () => {
    let loginCount = 0;
    const base = fakeVaultGateway();
    const tokenGateway: VaultHttpGateway = {
      ...base.impl,
      loginKubernetes: async () => {
        loginCount += 1;
        return { clientToken: `hvs.kube.${loginCount}`, leaseDurationSec: 3600, renewable: true };
      },
    };
    // Use this test file's own path as the SA token mount — its content reads as a non-empty "JWT".
    const provider = createVaultProvider({
      config: {
        address: "https://v",
        namespace: null,
        kvMount: "secret",
        kvPathPrefix: "paperclip",
        auth: { method: "kubernetes", role: "paperclip-server", saTokenPath: __filename },
        versionRetention: 10,
      },
      gateway: tokenGateway,
    });
    const ctx = {
      companyId: "co",
      deploymentId: "d",
      secretId: "s",
      secretKey: "K",
      secretName: "K",
      version: 1,
    } as const;
    const v1 = await provider.createSecret({ value: "x", context: ctx });
    await provider.createVersion({ value: "y", context: ctx, externalRef: v1.externalRef });
    await provider.resolveVersion({
      material: v1.material,
      externalRef: v1.externalRef,
      context: { companyId: ctx.companyId, secretId: ctx.secretId, secretKey: ctx.secretKey, version: 1 },
    });
    expect(loginCount).toBe(1);
  });

  it("parseExternalRef rejects '..' mount (path traversal)", () => {
    expect(() => parseExternalRef("../admin/data/secret")).toThrow(/mount must match/i);
  });

  it("parseExternalRef rejects '.' or '..' path segments", () => {
    expect(() => parseExternalRef("secret/teams/../admin")).toThrow(/must not contain/);
    expect(() => parseExternalRef("secret/teams/./admin")).toThrow(/must not contain/);
  });

  it("parseExternalRef rejects mount with invalid characters", () => {
    expect(() => parseExternalRef("sec ret/foo/bar")).toThrow(/mount must match/i);
    expect(() => parseExternalRef("sec/ret/foo/bar")).not.toThrow();
  });

  it("PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION is parsed as base-10 integer (no NaN from non-numeric)", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v.example:8200",
        PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION: "abc",
      },
      providerConfig: null,
    });
    expect(r.config).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/versionRetention must be an integer/i);
  });

  it("PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION accepts a leading-zero integer string", () => {
    const r = resolveVaultConfig({
      env: {
        PAPERCLIP_SECRETS_VAULT_ADDR: "https://v.example:8200",
        PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION: "07",
      },
      providerConfig: null,
    });
    expect(r.config?.versionRetention).toBe(7);
  });
});

describe("HttpVaultGateway.call — network error mapping", () => {
  const prevFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = prevFetch;
    vi.restoreAllMocks();
  });

  function makeGateway() {
    return new HttpVaultGateway({
      address: "https://v:8200",
      namespace: null,
      getToken: async () => "tok",
      timeoutMs: 5000,
    });
  }

  it("wraps a network (connect) failure in a provider_unavailable error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const err = await makeGateway().health().catch((e) => e);
    expect(err).toBeInstanceOf(SecretProviderClientError);
    expect((err as SecretProviderClientError).code).toBe("provider_unavailable");
    expect((err as SecretProviderClientError).message).toMatch(/failed/i);
  });

  it("wraps a timeout (AbortSignal) as provider_unavailable with a 'timed out' message", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const err = await makeGateway().health().catch((e) => e);
    expect(err).toBeInstanceOf(SecretProviderClientError);
    expect((err as SecretProviderClientError).code).toBe("provider_unavailable");
    expect((err as SecretProviderClientError).message).toMatch(/timed out after 5000ms/);
  });

  it("still maps an HTTP status body (e.g. 503) to the status-derived code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: ["service unavailable"] }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const err = await makeGateway().health().catch((e) => e);
    expect(err).toBeInstanceOf(SecretProviderClientError);
    expect((err as SecretProviderClientError).code).toBe("provider_unavailable");
  });

  it("a timed-out call does not poison the next call (each request has its own deadline)", async () => {
    const gateway = makeGateway();
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    // First call times out; the second succeeds. A single spy: the first
    // call consumes the `once` rejection, subsequent calls use the base impl.
    const f = vi.spyOn(globalThis, "fetch");
    f.mockRejectedValueOnce(abortErr);
    f.mockResolvedValue(
      new Response(JSON.stringify({ initialized: true, sealed: false, version: "1.0.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const first = await gateway.health().catch((e) => e);
    expect(first).toBeInstanceOf(SecretProviderClientError);
    expect((first as SecretProviderClientError).code).toBe("provider_unavailable");
    const second = await gateway.health();
    expect(second.initialized).toBe(true);
  });
});
