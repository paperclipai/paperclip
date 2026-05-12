# Vault Secret Provider (OpenBao-Bundled) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the `vault` SecretProvider from a `coming_soon` stub to a real implementation that talks the Vault HTTP API and works against both OpenBao and HashiCorp Vault.

**Architecture:** A single `server/src/secrets/vault-provider.ts` module, structural sibling of `aws-secrets-manager-provider.ts`. The provider depends on an internal `VaultHttpGateway` interface; a production `undici`-backed gateway implementation lives in the same file. Unit tests inject a fake gateway. Kubernetes auth method is used in-cluster; token auth is used locally. KV v2 paths follow `<mount>/data/<prefix>/<deploymentId>/<companyId>/<key>` with one `value` data key. Vault-side `max_versions` enforces retention.

**Tech Stack:** TypeScript, `undici` (already in `server/package.json`), Vitest, Vault KV v2 + `auth/kubernetes` HTTP API.

**Spec:** `docs/superpowers/specs/2026-05-12-vault-secret-provider-design.md`

---

## File Structure

**New files:**

- `server/src/secrets/vault-provider.ts` — Provider module. Exports `createVaultProvider({ config?, gateway? })` factory and a default `vaultProvider` instance derived from env. Internal `VaultHttpGateway` interface plus `UndiciVaultGateway` production implementation. ~600 lines target.
- `server/src/__tests__/vault-provider.test.ts` — Unit tests covering validation, config resolution, auth detection, token lifecycle, CRUD, external references, soft-delete, health probes. Uses fake gateway. ~600 lines target.
- `server/src/__tests__/vault-provider-integration.test.ts` — Opt-in integration test against a locally-running `bao server -dev`. Gated by `PAPERCLIP_TEST_VAULT=1`. ~150 lines target.
- `doc/SECRETS-VAULT-PROVIDER.md` — Operator-facing operational contract doc. Mirrors `doc/SECRETS-AWS-PROVIDER.md`. Describes bootstrap, policy, helm bundling, runbooks.

**Modified files:**

- `server/src/secrets/provider-registry.ts` — Import `vaultProvider` from `./vault-provider.js`; replace the `vaultProvider` import from `./external-stub-providers.js`.
- `server/src/secrets/external-stub-providers.ts` — Remove the `vault` stub export. The `gcp_secret_manager` stub stays.
- `docs/deploy/secrets.md` — Remove or update wording that marks `vault` as `coming_soon`. Add a vault-provider section pointing at `doc/SECRETS-VAULT-PROVIDER.md`.
- `docs/api/secrets.md` — Add the vault per-vault config schema to the Provider Vaults section.

**Not touched:**

- `server/src/secrets/types.ts` — Interface already complete.
- `@paperclipai/shared` — `SecretProvider` enum already contains `"vault"`.
- Database — no migration required.
- UI — already supports the `vault` provider in `ImportFromVaultDialog`/`Secrets.tsx`; status will flip from `coming_soon` to `ready` automatically via the provider's descriptor.
- Credential broker code — orthogonal, unaffected.

---

## Conventions

- All TypeScript files use `.js` extensions in import paths (ESM convention this repo follows).
- Tests use Vitest, mirroring `server/src/__tests__/aws-secrets-manager-provider.test.ts` (already on disk — read it as the canonical example of test shape, fake-gateway pattern, env-restoration pattern).
- After each task that introduces behavior, run the focused test file with `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts` and confirm only the new tests change state (no regressions).
- Commit messages follow Conventional Commits with `(secrets)` or `(server)` scope, matching recent commits visible via `git log --oneline server/src/secrets/`.
- Do NOT commit `pnpm-lock.yaml`. Memory entry `feedback_paperclip_lockfile_policy` is enforced by the refresh-bot post-merge.

---

## Task 1: Scaffold the module and the first failing test

**Files:**

- Create: `server/src/secrets/vault-provider.ts`
- Create: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Create the empty provider module with the factory signature**

`server/src/secrets/vault-provider.ts`:

```ts
import type {
  PreparedSecretVersion,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderRuntimeContext,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

export const VAULT_MATERIAL_SCHEME = "vault_kv_v2";
export const DEFAULT_KV_MOUNT = "secret";
export const DEFAULT_KV_PATH_PREFIX = "paperclip";
export const DEFAULT_VERSION_RETENTION = 10;
export const MIN_VERSION_RETENTION = 2;
export const MAX_VERSION_RETENTION = 100;
export const DEFAULT_SA_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
export const TOKEN_RENEWAL_THRESHOLD = 0.7;
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

export interface VaultProviderConfig {
  address: string;
  namespace: string | null;
  kvMount: string;
  kvPathPrefix: string;
  auth: {
    method: "kubernetes" | "token";
    role: string | null;
    saTokenPath: string;
  };
  versionRetention: number;
}

export interface VaultHttpGateway {
  // Filled in over subsequent tasks.
}

export function createVaultProvider(
  _options?: { config?: VaultProviderConfig; gateway?: VaultHttpGateway },
): SecretProviderModule {
  throw new Error("not implemented yet");
}

export const vaultProvider: SecretProviderModule = createVaultProvider();
```

Note: the trailing `vaultProvider` export will throw at import time today. That is intentional — Task 1 only sets up the scaffold; the test in Step 2 imports the factory directly, not the default export. Task 2 fixes the throw.

- [ ] **Step 2: Write a failing test for the module's first behavior — factory does not throw with no args**

`server/src/__tests__/vault-provider.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVaultProvider } from "../secrets/vault-provider.js";

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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "constructs a module"`

Expected: FAIL with "not implemented yet".

- [ ] **Step 4: Implement the minimal factory to make the test pass**

Replace the body of `createVaultProvider` in `server/src/secrets/vault-provider.ts`:

```ts
export function createVaultProvider(
  _options?: { config?: VaultProviderConfig; gateway?: VaultHttpGateway },
): SecretProviderModule {
  return {
    id: "vault",
    descriptor() {
      return {
        id: "vault",
        label: "HashiCorp Vault / OpenBao",
        requiresExternalRef: false,
        supportsManagedValues: true,
        supportsExternalReferences: true,
        configured: false,
      };
    },
    async validateConfig() {
      return { ok: false, warnings: ["validateConfig not implemented yet"] };
    },
    async createSecret() {
      throw new Error("createSecret not implemented yet");
    },
    async createVersion() {
      throw new Error("createVersion not implemented yet");
    },
    async linkExternalSecret() {
      throw new Error("linkExternalSecret not implemented yet");
    },
    async resolveVersion() {
      throw new Error("resolveVersion not implemented yet");
    },
    async deleteOrArchive() {
      // no-op stub
    },
    async healthCheck() {
      return {
        provider: "vault",
        status: "warn",
        message: "healthCheck not implemented yet",
      };
    },
  };
}
```

Also replace the trailing line that throws at module load with a lazy export to keep the registry happy until env-driven loading is implemented:

```ts
export const vaultProvider: SecretProviderModule = createVaultProvider();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "constructs a module"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): scaffold vault provider module + first test"
```

---

## Task 2: validateConfig — address validation

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Add failing tests for address validation**

Append to `server/src/__tests__/vault-provider.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "address rules"`

Expected: 5 failures, all on the `not implemented yet` validateConfig stub.

- [ ] **Step 3: Implement address validation in vault-provider.ts**

In `server/src/secrets/vault-provider.ts`, add helpers above `createVaultProvider`:

```ts
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateAddress(raw: unknown, warnings: string[]): URL | null {
  const value = asString(raw);
  if (!value) {
    warnings.push("vault address is required (set vault config address or PAPERCLIP_SECRETS_VAULT_ADDR)");
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    warnings.push(`vault address is not a valid URL: ${value}`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warnings.push(`vault address must use http(s); got ${parsed.protocol}`);
    return null;
  }
  if (parsed.username || parsed.password) {
    warnings.push("vault address must not embed credentials in the URL");
    return null;
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    warnings.push(`vault address must be origin-only; got path ${parsed.pathname}`);
    return null;
  }
  if (parsed.search) {
    warnings.push("vault address must not include a query string");
    return null;
  }
  if (parsed.hash) {
    warnings.push("vault address must not include a fragment");
    return null;
  }
  return parsed;
}
```

Replace the `validateConfig` stub returned by the factory:

```ts
async validateConfig(input) {
  const warnings: string[] = [];
  const rawConfig = (input?.providerConfig?.config ?? {}) as Record<string, unknown>;
  validateAddress(rawConfig.address, warnings);
  return { ok: warnings.length === 0, warnings };
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "address rules"`

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault provider address validation"
```

---

## Task 3: validateConfig — mount, prefix, role, retention rules

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `server/src/__tests__/vault-provider.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "mount, prefix, role, retention"`

Expected: 8 failures (every test fails because the validator only checks address).

- [ ] **Step 3: Extend the validator**

In `server/src/secrets/vault-provider.ts`, add helpers:

```ts
const KV_MOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;
const KV_PREFIX_PATTERN = /^[A-Za-z0-9._/-]+$/;
const ROLE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function validateKvMount(raw: unknown, warnings: string[]): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_KV_MOUNT;
  const value = asString(raw);
  if (!value) {
    warnings.push("kvMount must be a non-empty string");
    return null;
  }
  if (value.startsWith("/") || value.startsWith("data/")) {
    warnings.push(`kvMount must not start with '/' or 'data/'; got ${value}`);
    return null;
  }
  if (!KV_MOUNT_PATTERN.test(value)) {
    warnings.push(`kvMount must match [A-Za-z0-9._-]; got ${value}`);
    return null;
  }
  return value;
}

function validateKvPathPrefix(raw: unknown, warnings: string[]): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_KV_PATH_PREFIX;
  const value = asString(raw);
  if (!value) {
    warnings.push("kvPathPrefix must be a non-empty string");
    return null;
  }
  if (value.startsWith("/")) {
    warnings.push(`kvPathPrefix must not start with '/'; got ${value}`);
    return null;
  }
  if (!KV_PREFIX_PATTERN.test(value)) {
    warnings.push(`kvPathPrefix must match [A-Za-z0-9._/-]; got ${value}`);
    return null;
  }
  return value;
}

function validateAuthBlock(
  raw: unknown,
  warnings: string[],
): { method: "kubernetes" | "token"; role: string | null; saTokenPath: string } | null {
  const block = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const methodRaw = asString(block.method);
  if (methodRaw && methodRaw !== "kubernetes" && methodRaw !== "token") {
    warnings.push(`auth.method must be 'kubernetes' or 'token'; got ${methodRaw}`);
    return null;
  }
  const method = (methodRaw ?? "token") as "kubernetes" | "token";
  const role = asString(block.role);
  if (method === "kubernetes") {
    if (!role) {
      warnings.push("auth.role is required when auth.method = 'kubernetes'");
      return null;
    }
    if (!ROLE_PATTERN.test(role)) {
      warnings.push(`auth.role must match [A-Za-z0-9_-]{1,128}; got ${role}`);
      return null;
    }
  }
  return {
    method,
    role,
    saTokenPath: asString(block.saTokenPath) ?? DEFAULT_SA_TOKEN_PATH,
  };
}

function validateVersionRetention(raw: unknown, warnings: string[]): number | null {
  if (raw === undefined || raw === null) return DEFAULT_VERSION_RETENTION;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    warnings.push("versionRetention must be an integer");
    return null;
  }
  if (raw < MIN_VERSION_RETENTION || raw > MAX_VERSION_RETENTION) {
    warnings.push(
      `versionRetention must be between ${MIN_VERSION_RETENTION} and ${MAX_VERSION_RETENTION}; got ${raw}`,
    );
    return null;
  }
  return raw;
}
```

Replace the `validateConfig` body:

```ts
async validateConfig(input) {
  const warnings: string[] = [];
  const rawConfig = (input?.providerConfig?.config ?? {}) as Record<string, unknown>;
  validateAddress(rawConfig.address, warnings);
  validateKvMount(rawConfig.kvMount, warnings);
  validateKvPathPrefix(rawConfig.kvPathPrefix, warnings);
  validateAuthBlock(rawConfig.auth, warnings);
  validateVersionRetention(rawConfig.versionRetention, warnings);
  return { ok: warnings.length === 0, warnings };
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "mount, prefix, role, retention"`

Expected: 8 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault provider mount/prefix/role/retention validation"
```

---

## Task 4: validateConfig — credential-shaped-field denylist

Rejects any vault config that contains keys looking like credentials. Matches the AWS provider's existing denylist behavior (extended for Vault).

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "credential-shaped-field denylist"`

Expected: 12 failures.

- [ ] **Step 3: Implement the denylist**

In `server/src/secrets/vault-provider.ts`, add at the top with other constants:

```ts
const CREDENTIAL_FIELD_DENYLIST = [
  "token",
  "password",
  "roleid",
  "secretid",
  "unsealkey",
  "clientcert",
  "privatekey",
  "accesskeyid",
  "secretaccesskey",
  "serviceaccountjson",
  "keyfile",
];

function validateNoCredentialFields(
  config: Record<string, unknown>,
  warnings: string[],
): void {
  for (const key of Object.keys(config)) {
    if (CREDENTIAL_FIELD_DENYLIST.includes(key.toLowerCase())) {
      warnings.push(
        `vault config must not contain credential-shaped field '${key}'; bootstrap credentials live in workload identity or VAULT_TOKEN env, never in vault config`,
      );
    }
  }
}
```

Wire it into `validateConfig`:

```ts
async validateConfig(input) {
  const warnings: string[] = [];
  const rawConfig = (input?.providerConfig?.config ?? {}) as Record<string, unknown>;
  validateNoCredentialFields(rawConfig, warnings);
  validateAddress(rawConfig.address, warnings);
  validateKvMount(rawConfig.kvMount, warnings);
  validateKvPathPrefix(rawConfig.kvPathPrefix, warnings);
  validateAuthBlock(rawConfig.auth, warnings);
  validateVersionRetention(rawConfig.versionRetention, warnings);
  return { ok: warnings.length === 0, warnings };
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "credential-shaped-field denylist"`

Expected: 12 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault provider credential-field denylist in validateConfig"
```

---

## Task 5: Config resolution — defaults, env, and vault-config layering

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { resolveVaultConfig } from "../secrets/vault-provider.js";

describe("resolveVaultConfig", () => {
  it("uses static defaults when nothing is set", () => {
    const r = resolveVaultConfig({ env: {}, providerConfig: null });
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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "resolveVaultConfig"`

Expected: 4 failures (function doesn't exist).

- [ ] **Step 3: Implement `resolveVaultConfig`**

In `server/src/secrets/vault-provider.ts`, add:

```ts
export interface ResolvedVaultConfig {
  config: VaultProviderConfig | null;
  warnings: string[];
}

export function resolveVaultConfig(input: {
  env: NodeJS.ProcessEnv;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
}): ResolvedVaultConfig {
  const warnings: string[] = [];
  const vaultConfig =
    (input.providerConfig?.config ?? {}) as Record<string, unknown>;

  validateNoCredentialFields(vaultConfig, warnings);

  function fromConfigOrEnv(key: keyof typeof vaultConfig, envKey: string): unknown {
    if (vaultConfig[key] !== undefined) return vaultConfig[key];
    return input.env[envKey];
  }

  const url = validateAddress(
    fromConfigOrEnv("address", "PAPERCLIP_SECRETS_VAULT_ADDR"),
    warnings,
  );
  const kvMount = validateKvMount(
    fromConfigOrEnv("kvMount", "PAPERCLIP_SECRETS_VAULT_KV_MOUNT"),
    warnings,
  );
  const kvPathPrefix = validateKvPathPrefix(
    fromConfigOrEnv("kvPathPrefix", "PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX"),
    warnings,
  );

  const authRaw = (vaultConfig.auth ?? null) as Record<string, unknown> | null;
  const authMerged = authRaw ?? {
    method: input.env.PAPERCLIP_SECRETS_VAULT_AUTH_METHOD,
    role: input.env.PAPERCLIP_SECRETS_VAULT_K8S_ROLE,
    saTokenPath: input.env.PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH,
  };
  const auth = validateAuthBlock(authMerged, warnings);

  const versionRetentionRaw =
    vaultConfig.versionRetention !== undefined
      ? vaultConfig.versionRetention
      : input.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION !== undefined
        ? Number(input.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION)
        : undefined;
  const versionRetention = validateVersionRetention(versionRetentionRaw, warnings);

  const namespace =
    asString(vaultConfig.namespace) ??
    asString(input.env.PAPERCLIP_SECRETS_VAULT_NAMESPACE);

  if (!url || !kvMount || !kvPathPrefix || !auth || versionRetention === null) {
    return { config: null, warnings };
  }
  return {
    config: {
      address: url.origin,
      namespace,
      kvMount,
      kvPathPrefix,
      auth,
      versionRetention,
    },
    warnings,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "resolveVaultConfig"`

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault config resolution (defaults/env/vault config)"
```

---

## Task 6: Auth detection — token mode + kubernetes mode + failure

Implements the "what is the active auth path" logic from spec §HTTP Client and Authentication. Returns a structured result without performing any HTTP yet. HTTP happens in Task 8 once the gateway exists.

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import {
  detectVaultAuthSource,
  type VaultAuthSource,
} from "../secrets/vault-provider.js";

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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "detectVaultAuthSource"`

Expected: 4 failures.

- [ ] **Step 3: Implement `detectVaultAuthSource`**

In `server/src/secrets/vault-provider.ts`, add:

```ts
export type VaultAuthSource =
  | { mode: "token"; token: string }
  | { mode: "kubernetes"; role: string; jwt: string; saTokenPath: string }
  | { mode: "error"; message: string };

export function detectVaultAuthSource(input: {
  config: VaultProviderConfig;
  env: NodeJS.ProcessEnv;
  readSaToken: (path: string) => string | null;
}): VaultAuthSource {
  const { config, env, readSaToken } = input;

  if (config.auth.method === "kubernetes") {
    const jwt = readSaToken(config.auth.saTokenPath);
    if (!jwt) {
      return {
        mode: "error",
        message:
          "auth.method = 'kubernetes' but no SA token found at " +
          config.auth.saTokenPath,
      };
    }
    if (!config.auth.role) {
      return {
        mode: "error",
        message: "auth.method = 'kubernetes' requires auth.role",
      };
    }
    return { mode: "kubernetes", role: config.auth.role, jwt, saTokenPath: config.auth.saTokenPath };
  }

  // method = token (explicit or defaulted)
  const token = asString(env.VAULT_TOKEN);
  if (token) return { mode: "token", token };

  return {
    mode: "error",
    message:
      "no Vault auth source detected: configure auth.method = 'kubernetes' " +
      "with role=<role> in cluster, or set VAULT_TOKEN env for local dev",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "detectVaultAuthSource"`

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault auth source detection (token/kubernetes/error)"
```

---

## Task 7: VaultHttpGateway interface + KV path construction helpers

Defines the gateway interface that production code and tests both implement, and the path helpers that turn `(deploymentId, companyId, secretKey)` into a Vault KV path.

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { buildManagedKvPath, parseExternalRef } from "../secrets/vault-provider.js";

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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "buildManagedKvPath|parseExternalRef"`

Expected: 5 failures.

- [ ] **Step 3: Add path helpers and the gateway interface**

In `server/src/secrets/vault-provider.ts`, add:

```ts
export interface ParsedExternalRef {
  mount: string;
  path: string;
  dataKey: string;
}

export function parseExternalRef(raw: string): ParsedExternalRef {
  if (!raw || raw === "/") throw unprocessable("vault external ref is empty");
  const [pathPart, dataKey = "value"] = raw.split("#", 2);
  const segments = pathPart.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw unprocessable(
      `vault external ref must be '<mount>/<path>[#<dataKey>]'; got ${raw}`,
    );
  }
  const [mount, ...rest] = segments;
  return { mount, path: rest.join("/"), dataKey };
}

export function buildManagedKvPath(input: {
  config: VaultProviderConfig;
  deploymentId: string;
  companyId: string;
  secretKey: string;
}): string {
  const segments = [
    input.config.kvPathPrefix,
    input.deploymentId,
    input.companyId,
    input.secretKey,
  ].filter((s) => s.length > 0);
  return segments.join("/");
}

export interface VaultHttpGateway {
  health(): Promise<{
    initialized?: boolean;
    sealed?: boolean;
    standby?: boolean;
    version?: string;
    cluster_name?: string;
  }>;
  loginKubernetes(input: { role: string; jwt: string }): Promise<{
    clientToken: string;
    leaseDurationSec: number;
    renewable: boolean;
  }>;
  renewSelf(): Promise<{ leaseDurationSec: number; renewable: boolean }>;
  lookupSelf(): Promise<{ leaseDurationSec: number; renewable: boolean; policies: string[] }>;
  capabilitiesSelf(paths: string[]): Promise<Record<string, string[]>>;
  readMount(mount: string): Promise<{ type: string; options: Record<string, string> }>;
  putKv(input: {
    mount: string;
    path: string;
    data: Record<string, string>;
    cas?: number;
  }): Promise<{ version: number }>;
  getKv(input: {
    mount: string;
    path: string;
    version?: number;
  }): Promise<{ data: Record<string, string>; version: number }>;
  setKvMetadata(input: {
    mount: string;
    path: string;
    maxVersions: number;
  }): Promise<void>;
  deleteKv(input: { mount: string; path: string }): Promise<void>;
}
```

Add the import at the top:

```ts
import { unprocessable } from "../errors.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "buildManagedKvPath|parseExternalRef"`

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault provider gateway interface + KV path helpers"
```

---

## Task 8: Token lifecycle — TokenManager with proactive renewal

Implements the in-memory token cache and 70%-of-TTL proactive renewal. Single-retry on 403 is added in Task 9.

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { VaultTokenManager } from "../secrets/vault-provider.js";

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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "VaultTokenManager"`

Expected: 5 failures.

- [ ] **Step 3: Implement `VaultTokenManager`**

In `server/src/secrets/vault-provider.ts`, add:

```ts
export class VaultTokenManager {
  private readonly source: VaultAuthSource;
  private readonly gateway: Pick<VaultHttpGateway, "loginKubernetes" | "renewSelf">;
  private readonly now: () => number;
  private cached: { token: string; acquiredAt: number; ttlMs: number; renewable: boolean } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(input: {
    source: VaultAuthSource;
    gateway: Pick<VaultHttpGateway, "loginKubernetes" | "renewSelf">;
    now?: () => number;
  }) {
    this.source = input.source;
    this.gateway = input.gateway;
    this.now = input.now ?? Date.now;
  }

  invalidate(): void {
    this.cached = null;
  }

  async acquire(): Promise<string> {
    if (this.source.mode === "token") return this.source.token;
    if (this.source.mode === "error") throw unprocessable(this.source.message);

    if (this.inflight) return this.inflight;
    this.inflight = this.acquireInner().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async acquireInner(): Promise<string> {
    if (this.source.mode !== "kubernetes") {
      throw new Error("acquireInner only used in kubernetes mode");
    }
    const now = this.now();
    if (this.cached) {
      const elapsed = now - this.cached.acquiredAt;
      const ttlMs = this.cached.ttlMs;
      const renewThreshold = ttlMs * TOKEN_RENEWAL_THRESHOLD;
      const expiryThreshold = ttlMs - TOKEN_EXPIRY_SKEW_MS;
      if (elapsed < renewThreshold) return this.cached.token;
      if (elapsed < expiryThreshold && this.cached.renewable) {
        try {
          const renewed = await this.gateway.renewSelf();
          this.cached = {
            token: this.cached.token,
            acquiredAt: now,
            ttlMs: renewed.leaseDurationSec * 1000,
            renewable: renewed.renewable,
          };
          return this.cached.token;
        } catch {
          // fallthrough to re-login
        }
      }
    }
    if (this.source.mode !== "kubernetes") throw new Error("unreachable");
    const login = await this.gateway.loginKubernetes({
      role: this.source.role,
      jwt: this.source.jwt,
    });
    this.cached = {
      token: login.clientToken,
      acquiredAt: now,
      ttlMs: login.leaseDurationSec * 1000,
      renewable: login.renewable,
    };
    return this.cached.token;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "VaultTokenManager"`

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): VaultTokenManager with proactive renewal"
```

---

## Task 9: 403-retry guard on downstream calls

Adds a small helper that wraps a gateway call: on `403 permission_denied`, invalidate the token cache and retry exactly once in kubernetes mode; surface `access_denied` immediately in token mode.

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { withVaultTokenRetry } from "../secrets/vault-provider.js";

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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "withVaultTokenRetry"`

Expected: 4 failures.

- [ ] **Step 3: Implement the helper**

In `server/src/secrets/vault-provider.ts`, add:

```ts
export async function withVaultTokenRetry<T>(input: {
  tokenManager: VaultTokenManager;
  sourceMode: VaultAuthSource["mode"];
  operation: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.operation();
  } catch (error) {
    if (
      input.sourceMode === "kubernetes" &&
      error instanceof SecretProviderClientError &&
      error.code === "access_denied"
    ) {
      input.tokenManager.invalidate();
      return await input.operation();
    }
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "withVaultTokenRetry"`

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault 403-retry guard with single re-login in k8s mode"
```

---

## Task 10: createSecret (managed value)

Implements the first end-to-end provider method using the gateway. After this task the provider can write a Paperclip-managed secret to Vault.

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append a fake-gateway helper and failing tests**

```ts
type FakeStore = Map<string, { versions: string[][] }>;

function fakeVaultGateway(): {
  store: FakeStore;
  maxVersions: Map<string, number>;
  impl: VaultHttpGateway;
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
      },
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
      context: { companyId: "co", deploymentId: "d", secretId: "s", secretKey: "K", secretName: "K", version: 1 },
    });
    expect(JSON.stringify(result.material)).not.toContain("supersecret");
  });
});
```

`SecretProviderWriteContext` already includes `companyId`, `secretId`, `secretKey`, `secretName`, `version`. **Verify the `deploymentId` field exists** by reading `server/src/secrets/types.ts` lines 100–125 before implementing; if it doesn't exist on the type yet, source it from `loadVaultDeploymentEnv()` (read `PAPERCLIP_DEPLOYMENT_ID` or similar — check how `aws-secrets-manager-provider.ts` derives `deploymentId` in `loadAwsSecretsManagerConfig`).

- [ ] **Step 2: Run tests to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "createSecret"`

Expected: 2 failures (createSecret still throws "not implemented yet").

- [ ] **Step 3: Implement createSecret**

In `server/src/secrets/vault-provider.ts`, refactor the factory so it wires up a token manager from the resolved config, then replace the `createSecret` stub:

```ts
interface VaultManagedMaterial extends StoredSecretVersionMaterial {
  scheme: typeof VAULT_MATERIAL_SCHEME;
  source: "managed" | "external_reference";
  mount: string;
  path: string;
  dataKey: string;
  version: number | null;
}

function managedMaterial(input: {
  mount: string;
  path: string;
  version: number;
}): VaultManagedMaterial {
  return {
    scheme: VAULT_MATERIAL_SCHEME,
    source: "managed",
    mount: input.mount,
    path: input.path,
    dataKey: "value",
    version: input.version,
  };
}

function fingerprintFromVersionAndPath(mount: string, path: string, version: number): string {
  return createHash("sha256").update(`${mount}/${path}@v${version}`).digest("hex");
}
```

Add at the top:

```ts
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
```

Rewrite the factory:

```ts
export function createVaultProvider(
  options?: { config?: VaultProviderConfig; gateway?: VaultHttpGateway },
): SecretProviderModule {
  function readSaToken(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null): VaultProviderConfig {
    if (options?.config) return options.config;
    const resolved = resolveVaultConfig({
      env: process.env,
      providerConfig: providerConfig ?? null,
    });
    if (!resolved.config) {
      throw unprocessable(
        `vault provider config invalid: ${resolved.warnings.join("; ")}`,
      );
    }
    return resolved.config;
  }

  function resolveGateway(_config: VaultProviderConfig): VaultHttpGateway {
    if (options?.gateway) return options.gateway;
    throw unprocessable(
      "vault provider has no http gateway configured; production gateway is added in a follow-up task",
    );
    // Replaced by UndiciVaultGateway construction in Task 17.
  }

  function tokenManagerFor(config: VaultProviderConfig, gateway: VaultHttpGateway): VaultTokenManager {
    const source = detectVaultAuthSource({
      config,
      env: process.env,
      readSaToken,
    });
    return new VaultTokenManager({ source, gateway });
  }

  function deploymentId(): string {
    return process.env.PAPERCLIP_DEPLOYMENT_ID || "default";
  }

  return {
    id: "vault",
    descriptor() {
      return {
        id: "vault",
        label: "HashiCorp Vault / OpenBao",
        requiresExternalRef: false,
        supportsManagedValues: true,
        supportsExternalReferences: true,
        configured: true,
      };
    },
    async validateConfig(input) {
      const warnings: string[] = [];
      const rawConfig = (input?.providerConfig?.config ?? {}) as Record<string, unknown>;
      validateNoCredentialFields(rawConfig, warnings);
      validateAddress(rawConfig.address, warnings);
      validateKvMount(rawConfig.kvMount, warnings);
      validateKvPathPrefix(rawConfig.kvPathPrefix, warnings);
      validateAuthBlock(rawConfig.auth, warnings);
      validateVersionRetention(rawConfig.versionRetention, warnings);
      return { ok: warnings.length === 0, warnings };
    },
    async createSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const tokenManager = tokenManagerFor(config, gateway);
      const ctx = input.context;
      if (!ctx) {
        throw unprocessable("vault createSecret requires SecretProviderWriteContext");
      }
      const path = buildManagedKvPath({
        config,
        deploymentId: deploymentId(),
        companyId: ctx.companyId,
        secretKey: ctx.secretKey,
      });
      const valueSha256 = createHash("sha256").update(input.value).digest("hex");
      return await withVaultTokenRetry({
        tokenManager,
        sourceMode: tokenManager["source"]?.mode ?? "token",
        operation: async () => {
          await tokenManager.acquire();
          const { version } = await gateway.putKv({
            mount: config.kvMount,
            path,
            data: { value: input.value },
          });
          await gateway.setKvMetadata({
            mount: config.kvMount,
            path,
            maxVersions: config.versionRetention,
          });
          return {
            material: managedMaterial({ mount: config.kvMount, path, version }),
            valueSha256,
            fingerprintSha256: fingerprintFromVersionAndPath(config.kvMount, path, version),
            externalRef: `${config.kvMount}/${path}`,
            providerVersionRef: String(version),
          };
        },
      });
    },
    async createVersion() {
      throw new Error("createVersion not implemented yet");
    },
    async linkExternalSecret() {
      throw new Error("linkExternalSecret not implemented yet");
    },
    async resolveVersion() {
      throw new Error("resolveVersion not implemented yet");
    },
    async deleteOrArchive() { /* later */ },
    async healthCheck() {
      return { provider: "vault", status: "warn", message: "healthCheck not implemented yet" };
    },
  };
}
```

NOTE: the private `tokenManager["source"]?.mode` lookup is a temporary access until Task 11 lifts `sourceMode` onto a public getter — Task 11 cleans it up.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "createSecret"`

Expected: 2 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault createSecret writes managed KV path + max_versions"
```

---

## Task 11: Expose a public `sourceMode` on VaultTokenManager and clean up the createSecret call site

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Add a failing test**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "sourceMode"`

Expected: 1 failure ("sourceMode is undefined").

- [ ] **Step 3: Add the getter and replace the private access**

In `server/src/secrets/vault-provider.ts`, inside `VaultTokenManager`:

```ts
get sourceMode(): VaultAuthSource["mode"] {
  return this.source.mode;
}
```

Replace `tokenManager["source"]?.mode ?? "token"` with `tokenManager.sourceMode` in `createSecret`.

- [ ] **Step 4: Run tests to verify they all pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts`

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "refactor(secrets): expose VaultTokenManager.sourceMode"
```

---

## Task 12: createVersion (rotate with CAS conflict mapping)

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "createVersion"`

Expected: 2 failures ("createVersion not implemented yet").

- [ ] **Step 3: Implement createVersion**

In `server/src/secrets/vault-provider.ts`, replace the `createVersion` body:

```ts
async createVersion(input) {
  const config = resolveConfig(input.providerConfig);
  const gateway = resolveGateway(config);
  const tokenManager = tokenManagerFor(config, gateway);
  const ctx = input.context;
  if (!ctx) throw unprocessable("vault createVersion requires SecretProviderWriteContext");

  const path = buildManagedKvPath({
    config,
    deploymentId: deploymentId(),
    companyId: ctx.companyId,
    secretKey: ctx.secretKey,
  });
  const valueSha256 = createHash("sha256").update(input.value).digest("hex");

  const cas = ctx.version > 0 ? ctx.version : undefined;

  return await withVaultTokenRetry({
    tokenManager,
    sourceMode: tokenManager.sourceMode,
    operation: async () => {
      await tokenManager.acquire();
      const { version } = await gateway.putKv({
        mount: config.kvMount,
        path,
        data: { value: input.value },
        cas,
      });
      return {
        material: managedMaterial({ mount: config.kvMount, path, version }),
        valueSha256,
        fingerprintSha256: fingerprintFromVersionAndPath(config.kvMount, path, version),
        externalRef: `${config.kvMount}/${path}`,
        providerVersionRef: String(version),
      };
    },
  });
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "createVersion"`

Expected: 2 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault createVersion with CAS and conflict mapping"
```

---

## Task 13: resolveVersion (managed: latest + pinned)

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "resolveVersion — managed"`

Expected: 3 failures.

- [ ] **Step 3: Implement resolveVersion for managed material**

In `server/src/secrets/vault-provider.ts`, replace the `resolveVersion` body:

```ts
async resolveVersion(input) {
  const config = resolveConfig(input.providerConfig);
  const gateway = resolveGateway(config);
  const tokenManager = tokenManagerFor(config, gateway);

  if (!input.material || (input.material as { scheme?: string }).scheme !== VAULT_MATERIAL_SCHEME) {
    throw unprocessable("vault resolveVersion: material is not vault_kv_v2");
  }
  const material = input.material as unknown as VaultManagedMaterial;

  const versionOverride = input.providerVersionRef
    ? Number(input.providerVersionRef)
    : material.version ?? undefined;
  const version = typeof versionOverride === "number" && Number.isFinite(versionOverride) && versionOverride > 0
    ? versionOverride
    : undefined;

  return await withVaultTokenRetry({
    tokenManager,
    sourceMode: tokenManager.sourceMode,
    operation: async () => {
      await tokenManager.acquire();
      const { data } = await gateway.getKv({
        mount: material.mount,
        path: material.path,
        version,
      });
      const value = data[material.dataKey ?? "value"];
      if (typeof value !== "string") {
        throw new SecretProviderClientError({
          code: "not_found",
          provider: "vault",
          operation: "getKv",
          message: `vault data key '${material.dataKey ?? "value"}' missing from KV response`,
        });
      }
      return value;
    },
  });
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "resolveVersion — managed"`

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault resolveVersion for managed material"
```

---

## Task 14: linkExternalSecret + external-ref resolveVersion + overlap denylist

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "linkExternalSecret|resolveVersion — external"`

Expected: 3 failures.

- [ ] **Step 3: Implement linkExternalSecret and external resolution**

In `server/src/secrets/vault-provider.ts`, add helpers:

```ts
function externalReferenceMaterial(ref: ParsedExternalRef): VaultManagedMaterial {
  return {
    scheme: VAULT_MATERIAL_SCHEME,
    source: "external_reference",
    mount: ref.mount,
    path: ref.path,
    dataKey: ref.dataKey,
    version: null,
  };
}

function assertNotManagedOverlap(config: VaultProviderConfig, ref: ParsedExternalRef): void {
  if (ref.mount === config.kvMount && (ref.path === config.kvPathPrefix || ref.path.startsWith(`${config.kvPathPrefix}/`))) {
    throw unprocessable(
      `vault external ref overlaps Paperclip-managed prefix '${config.kvMount}/${config.kvPathPrefix}'`,
    );
  }
}
```

Replace the `linkExternalSecret` body in the factory:

```ts
async linkExternalSecret(input) {
  const config = resolveConfig(input.providerConfig);
  const parsed = parseExternalRef(input.externalRef);
  assertNotManagedOverlap(config, parsed);
  const fingerprint = createHash("sha256")
    .update(`${parsed.mount}/${parsed.path}#${parsed.dataKey}`)
    .digest("hex");
  return {
    material: externalReferenceMaterial(parsed),
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: input.externalRef,
    providerVersionRef: input.providerVersionRef ?? null,
  };
},
```

The existing `resolveVersion` already reads `material.dataKey`, so external references flow through it correctly. Verify by running the external test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "linkExternalSecret|resolveVersion — external"`

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault linkExternalSecret + external resolveVersion"
```

---

## Task 15: deleteOrArchive (soft-delete; archive is no-op)

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "deleteOrArchive"`

Expected: 1–3 failures (current stub is silent no-op for all paths; only the "delete actually deletes" test will fail).

- [ ] **Step 3: Implement deleteOrArchive**

In `server/src/secrets/vault-provider.ts`, replace the `deleteOrArchive` body:

```ts
async deleteOrArchive(input) {
  if (input.mode === "archive") return;

  const material = input.material as VaultManagedMaterial | undefined;
  if (!material || material.scheme !== VAULT_MATERIAL_SCHEME) return;
  if (material.source !== "managed") return;

  const config = resolveConfig(input.providerConfig);
  const gateway = resolveGateway(config);
  const tokenManager = tokenManagerFor(config, gateway);

  await withVaultTokenRetry({
    tokenManager,
    sourceMode: tokenManager.sourceMode,
    operation: async () => {
      await tokenManager.acquire();
      await gateway.deleteKv({ mount: material.mount, path: material.path });
    },
  });
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "deleteOrArchive"`

Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault deleteOrArchive (soft-delete managed; archive no-op)"
```

---

## Task 16: healthCheck (four probes)

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe("healthCheck", () => {
  function gwWith(over: Partial<VaultHttpGateway>): VaultHttpGateway {
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
```

- [ ] **Step 2: Run to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "healthCheck"`

Expected: 5 failures.

- [ ] **Step 3: Implement healthCheck**

In `server/src/secrets/vault-provider.ts`, replace the `healthCheck` body:

```ts
async healthCheck(input) {
  const warnings: string[] = [];
  let config: VaultProviderConfig | null;
  try {
    config = resolveConfig(input?.providerConfig);
  } catch (error) {
    return {
      provider: "vault",
      status: "warn",
      message:
        "vault provider is not configured for runtime resolution; external references can still be stored as metadata",
      warnings: [(error as Error).message],
    };
  }
  const gateway = resolveGateway(config);
  const details: Record<string, unknown> = {
    address: config.address,
    kvMount: config.kvMount,
    kvPathPrefix: config.kvPathPrefix,
    authMethod: config.auth.method,
  };

  // 1) reachability
  let healthStatus: { sealed?: boolean; standby?: boolean; version?: string } = {};
  try {
    healthStatus = await gateway.health();
    details.vaultVersion = healthStatus.version;
    details.standby = healthStatus.standby ?? false;
    if (healthStatus.sealed) warnings.push("vault is sealed; auth/data calls will fail until unsealed");
  } catch (error) {
    return {
      provider: "vault",
      status: "error",
      message: `vault unreachable at ${config.address}`,
      warnings: [(error as Error).message],
      details,
    };
  }

  // 2) auth probe
  const tokenManager = tokenManagerFor(config, gateway);
  try {
    if (tokenManager.sourceMode === "error") {
      throw new Error("no vault auth source detected");
    }
    await tokenManager.acquire();
    if (tokenManager.sourceMode === "token") {
      const info = await gateway.lookupSelf();
      details.tokenTtlSec = info.leaseDurationSec;
      details.tokenRenewable = info.renewable;
      details.policies = info.policies;
    }
  } catch (error) {
    warnings.push(`auth probe failed: ${(error as Error).message}`);
  }

  // 3) KV engine probe
  try {
    const mount = await gateway.readMount(config.kvMount);
    if (mount.options?.version !== "2") {
      warnings.push(`mount '${config.kvMount}' is kv v${mount.options?.version ?? "?"}; the vault provider requires kv v2`);
    }
  } catch (error) {
    warnings.push(`could not inspect mount '${config.kvMount}': ${(error as Error).message}`);
  }

  // 4) capabilities probe
  try {
    const probePath = `${config.kvMount}/data/${config.kvPathPrefix}/_health_probe`;
    const caps = await gateway.capabilitiesSelf([probePath]);
    const granted = caps[probePath] ?? [];
    const required = ["create", "read", "update", "delete"];
    const missing = required.filter((cap) => !granted.includes(cap));
    if (missing.length > 0) {
      warnings.push(`missing vault capabilities on ${probePath}: ${missing.join(", ")}`);
    }
    details.capabilities = granted;
  } catch (error) {
    warnings.push(`capabilities probe failed: ${(error as Error).message}`);
  }

  const status = warnings.length === 0 ? "ok" : "warn";
  return {
    provider: "vault",
    status,
    message:
      status === "ok"
        ? `vault provider healthy at ${config.address} (mount=${config.kvMount}, auth=${config.auth.method})`
        : `vault provider has warnings at ${config.address}`,
    warnings: warnings.length > 0 ? warnings : undefined,
    details,
  };
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "healthCheck"`

Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): vault healthCheck with reachability/auth/kv/capabilities probes"
```

---

## Task 17: Production UndiciVaultGateway

Wires the production `undici`-backed HTTP gateway into the factory so the default `vaultProvider` export becomes usable.

**Files:**

- Modify: `server/src/secrets/vault-provider.ts`
- Modify: `server/src/__tests__/vault-provider.test.ts`

- [ ] **Step 1: Add a focused HTTP-shape test for the gateway**

Append to `server/src/__tests__/vault-provider.test.ts`:

```ts
import { MockAgent, setGlobalDispatcher } from "undici";
import { UndiciVaultGateway } from "../secrets/vault-provider.js";

describe("UndiciVaultGateway", () => {
  it("sends X-Vault-Token + X-Vault-Namespace headers on KV reads", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get("https://vault.example:8200");
    pool
      .intercept({ path: "/v1/secret/data/paperclip/d/co/K", method: "GET" })
      .reply(200, { data: { data: { value: "v" }, metadata: { version: 1 } } });

    const gateway = new UndiciVaultGateway({
      address: "https://vault.example:8200",
      namespace: "ns1",
      getToken: async () => "hvs.kube.1",
    });
    const r = await gateway.getKv({ mount: "secret", path: "paperclip/d/co/K" });
    expect(r).toEqual({ data: { value: "v" }, version: 1 });
    pool.assertNoPendingInterceptors();
  });

  it("maps 403 to SecretProviderClientError(code:access_denied)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get("https://vault.example:8200");
    pool
      .intercept({ path: "/v1/secret/data/paperclip/d/co/K", method: "GET" })
      .reply(403, { errors: ["permission denied"] });
    const gateway = new UndiciVaultGateway({
      address: "https://vault.example:8200",
      namespace: null,
      getToken: async () => "hvs.k",
    });
    await expect(gateway.getKv({ mount: "secret", path: "paperclip/d/co/K" })).rejects.toMatchObject({
      code: "access_denied",
    });
  });

  it("maps 404 to not_found, 429 to throttled, 500 to provider_error", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get("https://vault.example:8200");
    for (const [status, code] of [
      [404, "not_found"],
      [429, "throttled"],
      [500, "provider_error"],
    ] as const) {
      pool.intercept({ path: "/v1/secret/data/x", method: "GET" }).reply(status, { errors: [] });
    }
    const gateway = new UndiciVaultGateway({
      address: "https://vault.example:8200",
      namespace: null,
      getToken: async () => "t",
    });
    await expect(gateway.getKv({ mount: "secret", path: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(gateway.getKv({ mount: "secret", path: "x" })).rejects.toMatchObject({ code: "throttled" });
    await expect(gateway.getKv({ mount: "secret", path: "x" })).rejects.toMatchObject({ code: "provider_error" });
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts -t "UndiciVaultGateway"`

Expected: 3 failures ("UndiciVaultGateway is undefined").

- [ ] **Step 3: Implement `UndiciVaultGateway`**

In `server/src/secrets/vault-provider.ts`, add:

```ts
import { request as undiciRequest } from "undici";

export class UndiciVaultGateway implements VaultHttpGateway {
  private readonly address: string;
  private readonly namespace: string | null;
  private readonly getToken: () => Promise<string>;

  constructor(input: { address: string; namespace: string | null; getToken: () => Promise<string> }) {
    this.address = input.address.replace(/\/$/, "");
    this.namespace = input.namespace;
    this.getToken = input.getToken;
  }

  private async call<T>(input: {
    method: "GET" | "POST" | "PUT" | "DELETE" | "LIST";
    path: string;
    body?: unknown;
    authenticated?: boolean;
  }): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (input.authenticated !== false) {
      headers["x-vault-token"] = await this.getToken();
    }
    if (this.namespace) headers["x-vault-namespace"] = this.namespace;

    const url = `${this.address}${input.path}`;
    const response = await undiciRequest(url, {
      method: input.method,
      headers,
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    });
    const text = await response.body.text();
    const status = response.statusCode;
    if (status >= 200 && status < 300) {
      return (text ? JSON.parse(text) : {}) as T;
    }
    const errBody = (() => { try { return JSON.parse(text); } catch { return { errors: [text] }; } })();
    const errors = Array.isArray(errBody?.errors) ? errBody.errors.join("; ") : String(text);
    const code = mapStatusToCode(status);
    throw new SecretProviderClientError({
      code,
      provider: "vault",
      operation: input.path,
      message: `vault ${input.method} ${input.path} returned ${status}: ${errors}`,
      status,
      rawMessage: errors,
    });
  }

  async health() {
    return this.call({ method: "GET", path: "/v1/sys/health?standbycode=200&sealedcode=200", authenticated: false });
  }
  async loginKubernetes(input: { role: string; jwt: string }) {
    const r = await this.call<{ auth: { client_token: string; lease_duration: number; renewable: boolean } }>({
      method: "POST",
      path: "/v1/auth/kubernetes/login",
      body: { role: input.role, jwt: input.jwt },
      authenticated: false,
    });
    return {
      clientToken: r.auth.client_token,
      leaseDurationSec: r.auth.lease_duration,
      renewable: r.auth.renewable,
    };
  }
  async renewSelf() {
    const r = await this.call<{ auth: { lease_duration: number; renewable: boolean } }>({
      method: "POST",
      path: "/v1/auth/token/renew-self",
    });
    return { leaseDurationSec: r.auth.lease_duration, renewable: r.auth.renewable };
  }
  async lookupSelf() {
    const r = await this.call<{ data: { ttl: number; renewable: boolean; policies: string[] } }>({
      method: "GET",
      path: "/v1/auth/token/lookup-self",
    });
    return { leaseDurationSec: r.data.ttl, renewable: r.data.renewable, policies: r.data.policies };
  }
  async capabilitiesSelf(paths: string[]) {
    const r = await this.call<Record<string, string[]>>({
      method: "POST",
      path: "/v1/sys/capabilities-self",
      body: { paths },
    });
    return r;
  }
  async readMount(mount: string) {
    return this.call<{ type: string; options: Record<string, string> }>({
      method: "GET",
      path: `/v1/sys/mounts/${encodeURIComponent(mount)}`,
    });
  }
  async putKv(input: { mount: string; path: string; data: Record<string, string>; cas?: number }) {
    const body: Record<string, unknown> = { data: input.data };
    if (input.cas !== undefined) body.options = { cas: input.cas };
    const r = await this.call<{ data: { version: number } }>({
      method: "POST",
      path: `/v1/${input.mount}/data/${input.path}`,
      body,
    });
    return { version: r.data.version };
  }
  async getKv(input: { mount: string; path: string; version?: number }) {
    const query = input.version !== undefined ? `?version=${input.version}` : "";
    const r = await this.call<{ data: { data: Record<string, string>; metadata: { version: number } } }>({
      method: "GET",
      path: `/v1/${input.mount}/data/${input.path}${query}`,
    });
    return { data: r.data.data, version: r.data.metadata.version };
  }
  async setKvMetadata(input: { mount: string; path: string; maxVersions: number }) {
    await this.call({
      method: "POST",
      path: `/v1/${input.mount}/metadata/${input.path}`,
      body: { max_versions: input.maxVersions },
    });
  }
  async deleteKv(input: { mount: string; path: string }) {
    await this.call({ method: "DELETE", path: `/v1/${input.mount}/data/${input.path}` });
  }
}

function mapStatusToCode(status: number): SecretProviderClientErrorCode {
  if (status === 401 || status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 409 || status === 400) return "conflict";
  if (status === 429) return "throttled";
  if (status === 502 || status === 503 || status === 504) return "provider_unavailable";
  return "provider_error";
}
```

Replace the placeholder `resolveGateway` body in the factory so production code uses the real gateway:

```ts
function resolveGateway(config: VaultProviderConfig): VaultHttpGateway {
  if (options?.gateway) return options.gateway;
  let tokenSupplier: () => Promise<string>;
  // Token supplier is wired by `tokenManagerFor` — closure shared.
  return new UndiciVaultGateway({
    address: config.address,
    namespace: config.namespace,
    getToken: () => {
      if (!tokenSupplier) throw unprocessable("vault token supplier not initialized");
      return tokenSupplier();
    },
  });
}
```

Refactor `tokenManagerFor` to publish the supplier into a shared closure:

```ts
let activeTokenSupplier: (() => Promise<string>) | null = null;

function tokenManagerFor(config: VaultProviderConfig, gateway: VaultHttpGateway): VaultTokenManager {
  const source = detectVaultAuthSource({
    config,
    env: process.env,
    readSaToken,
  });
  const tm = new VaultTokenManager({ source, gateway });
  activeTokenSupplier = () => tm.acquire();
  return tm;
}
```

And rewire the `resolveGateway` to use `activeTokenSupplier`:

```ts
function resolveGateway(config: VaultProviderConfig): VaultHttpGateway {
  if (options?.gateway) return options.gateway;
  return new UndiciVaultGateway({
    address: config.address,
    namespace: config.namespace,
    getToken: () => {
      if (!activeTokenSupplier) throw unprocessable("vault token supplier not initialized");
      return activeTokenSupplier();
    },
  });
}
```

NOTE the chicken-and-egg: the gateway is constructed before the token manager exists, but `getToken` is a closure resolved lazily, so the order is fine as long as no call is made before `tokenManagerFor` runs. Every operation in this provider calls `tokenManagerFor` before `gateway.*` (verify by reading each method). Add an inline comment marking that invariant.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/vault-provider.test.ts`

Expected: all green including the new `UndiciVaultGateway` tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/vault-provider.ts server/src/__tests__/vault-provider.test.ts
git commit -m "feat(secrets): production UndiciVaultGateway with status-to-error mapping"
```

---

## Task 18: Register the real provider, remove the stub

**Files:**

- Modify: `server/src/secrets/provider-registry.ts`
- Modify: `server/src/secrets/external-stub-providers.ts`
- Modify: `server/src/__tests__/secret-provider-registry.test.ts`

- [ ] **Step 1: Read existing files to spot the exact import shape**

Run: `sed -n '1,40p' server/src/secrets/provider-registry.ts server/src/secrets/external-stub-providers.ts`

- [ ] **Step 2: Write a failing test asserting the vault descriptor reports configured=true**

Append to `server/src/__tests__/secret-provider-registry.test.ts`:

```ts
import { listSecretProviders } from "../secrets/provider-registry.js";

it("registers the vault provider as a real implementation", () => {
  const list = listSecretProviders();
  const vault = list.find((p) => p.id === "vault");
  expect(vault?.label).toMatch(/Vault|OpenBao/);
  expect(vault?.supportsManagedValues).toBe(true);
  expect(vault?.supportsExternalReferences).toBe(true);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/secret-provider-registry.test.ts -t "registers the vault provider"`

Expected: FAIL (vault is still the stub from `external-stub-providers.ts`).

- [ ] **Step 4: Replace the registry wiring**

In `server/src/secrets/provider-registry.ts`, replace the existing block:

```ts
import { awsSecretsManagerProvider } from "./aws-secrets-manager-provider.js";
import { localEncryptedProvider } from "./local-encrypted-provider.js";
import {
  gcpSecretManagerProvider,
  vaultProvider,
} from "./external-stub-providers.js";
```

with:

```ts
import { awsSecretsManagerProvider } from "./aws-secrets-manager-provider.js";
import { localEncryptedProvider } from "./local-encrypted-provider.js";
import { vaultProvider } from "./vault-provider.js";
import { gcpSecretManagerProvider } from "./external-stub-providers.js";
```

(The `providers` array stays the same shape; only the import source changes.)

In `server/src/secrets/external-stub-providers.ts`, remove:

```ts
export const vaultProvider = unavailableProvider("vault", "HashiCorp Vault");
```

If `unavailableProvider` is now only referenced by `gcpSecretManagerProvider`, leave the helper as-is — no need to delete dead code unless this is the only remaining stub. Verify by `grep unavailableProvider server/src/secrets/external-stub-providers.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && pnpm vitest run src/__tests__/secret-provider-registry.test.ts`

Expected: all registry tests pass.

- [ ] **Step 6: Run the full secrets test suite to confirm no regression**

Run: `cd server && pnpm vitest run src/__tests__/secret-provider-registry.test.ts src/__tests__/vault-provider.test.ts src/__tests__/secrets-service.test.ts src/__tests__/aws-secrets-manager-provider.test.ts`

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add server/src/secrets/provider-registry.ts server/src/secrets/external-stub-providers.ts server/src/__tests__/secret-provider-registry.test.ts
git commit -m "feat(secrets): register vault provider; remove coming_soon stub"
```

---

## Task 19: Operator-facing doc — `doc/SECRETS-VAULT-PROVIDER.md`

**Files:**

- Create: `doc/SECRETS-VAULT-PROVIDER.md`

- [ ] **Step 1: Write the doc**

Create `doc/SECRETS-VAULT-PROVIDER.md` with the following content (modeled on `doc/SECRETS-AWS-PROVIDER.md`):

```markdown
# Vault Secret Provider (OpenBao / HashiCorp Vault)

Operational contract for the `vault` secret provider. The provider speaks the
Vault HTTP API and works against both OpenBao (MPL-2.0 Linux Foundation fork)
and HashiCorp Vault (BUSL-1.1). The Paperclip helm chart bundles OpenBao by
default; operators with an existing Vault deployment use the same provider
and point at their endpoint.

## Scope

- Hosted provider for Paperclip-managed secrets when Paperclip runs on
  Kubernetes (or any environment where Vault/OpenBao is reachable).
- Source of truth for secret values is the Vault KV v2 engine, not Postgres.
- Paperclip stores only metadata needed for ownership, bindings, version
  selection, audit, and runtime resolution.
- Provider bootstrap credentials are deployment/runtime credentials, not
  Paperclip-managed company secrets.

## Bootstrap Trust Model

Paperclip authenticates to Vault using **workload identity**. Allowed
bootstrap paths:

- In-cluster: Paperclip server pod's ServiceAccount JWT, validated by Vault
  through the Kubernetes auth method's `TokenReview` call.
- Local development: `VAULT_TOKEN` env or `~/.vault-token` file.
- An orchestrator secret store that boots the server with `VAULT_TOKEN`.

Do not paste Vault tokens, AppRole role/secret-ids, or any other credential
into the board UI or vault config. The API rejects credential-shaped fields.

## Deployment Config

Required environment variables when the deployment default provider is
`vault`:

```sh
PAPERCLIP_SECRETS_PROVIDER=vault
PAPERCLIP_SECRETS_VAULT_ADDR=http://openbao.paperclip.svc:8200
PAPERCLIP_SECRETS_VAULT_AUTH_METHOD=kubernetes
PAPERCLIP_SECRETS_VAULT_K8S_ROLE=paperclip-server
```

Optional environment variables:

```sh
PAPERCLIP_SECRETS_VAULT_NAMESPACE=                      # Vault Enterprise only
PAPERCLIP_SECRETS_VAULT_KV_MOUNT=secret
PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX=paperclip
PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION=10
PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH=/var/run/secrets/kubernetes.io/serviceaccount/token
```

Local development:

```sh
PAPERCLIP_SECRETS_PROVIDER=local_encrypted  # default stays local
# To exercise the vault provider locally:
VAULT_ADDR=http://127.0.0.1:8200
VAULT_TOKEN=<dev-root-or-period-token>
PAPERCLIP_SECRETS_VAULT_AUTH_METHOD=token
```

## KV Path and Tag Convention

```text
<kvMount>/data/<kvPathPrefix>/<deploymentId>/<companyId>/<secretKey>
```

KV payload is `{ "value": "<plaintext>" }`. KV v2's native version counter
is the version source of truth; `max_versions` (per vault config
`versionRetention`) enforces retention server-side.

## Required Vault Policy

```hcl
path "<mount>/data/<prefix>/*"     { capabilities = ["create","read","update","delete"] }
path "<mount>/delete/<prefix>/*"   { capabilities = ["update"] }
path "<mount>/undelete/<prefix>/*" { capabilities = ["update"] }
path "<mount>/metadata/<prefix>/*" { capabilities = ["read","list","update","delete"] }

# External references read-only
path "<mount>/data/+/*"            { capabilities = ["read"] }
```

The default policy intentionally omits `destroy`. Hard-destroy is only
reachable through `paperclipai secrets doctor --destroy <id> --confirm`,
which requires a separately-attached emergency policy.

## Helm Chart (OpenBao Bundled)

The Paperclip helm chart bundles OpenBao via dependency and pre-configures
the Kubernetes auth method, the policy above, and the KV mount through a
post-install Job. See `docs/deploy/secrets.md` for chart values, unseal
options, and operator runbooks.

## Health Checks

`POST /api/secret-provider-configs/{id}/health` runs four probes:

1. **Reachability** — `GET /v1/sys/health`; reports sealed/standby/version.
2. **Auth** — k8s login (returns role + token TTL) or `lookup-self` (token
   mode).
3. **KV engine** — `GET /v1/sys/mounts/<mount>`; confirms `options.version
   == "2"`. KV v1 is rejected with a clear message.
4. **Capabilities** — `POST /v1/sys/capabilities-self` against the managed
   prefix; lists missing capabilities by name.

Responses never include the Vault token, lease ids, or policy contents.

## Backup, Rotation, Incident Runbooks

- **Token rotation:** the provider renews the Vault token proactively at
  70% of TTL and re-logs-in on 403. Operators do not rotate tokens
  manually; rotation happens automatically.
- **Unseal:** an unsealed Vault returns `sealed=true` from `sys/health` and
  the provider health check reports `warning`. Restart unseals via the
  configured auto-unseal mechanism (transit/awskms/gcpckms/...), or perform
  a manual unseal per the OpenBao/Vault operator docs.
- **Backup:** Vault/OpenBao manages its own storage backend (Raft, Consul,
  etc.). Paperclip's database does not contain plaintext values from this
  provider. Restore both consistently.
- **Incident — leaked Vault token:** revoke the token in Vault
  (`vault token revoke`), confirm the next `acquire()` re-logs-in, and
  audit `sys/audit` logs for the leaked token's footprint.
```

- [ ] **Step 2: Commit**

```bash
git add doc/SECRETS-VAULT-PROVIDER.md
git commit -m "docs(secrets): operational contract for the vault provider"
```

---

## Task 20: Update `docs/deploy/secrets.md`

**Files:**

- Modify: `docs/deploy/secrets.md`

- [ ] **Step 1: Locate the section mentioning `vault` as coming-soon**

Run: `grep -n "vault\|coming.soon\|coming_soon" docs/deploy/secrets.md`

- [ ] **Step 2: Edit the file**

Two changes to apply:

1. In the "External References" section, the paragraph that says
   `gcp_secret_manager` and `vault` are stubs needs to drop the `vault`
   mention:

   FROM:

   ```markdown
   The built-in AWS, GCP, and Vault provider IDs currently accept external
   reference metadata, but runtime resolution requires provider configuration in the
   deployment. Their provider health check reports this as a warning until
   configured.
   ```

   TO:

   ```markdown
   The built-in AWS and Vault provider IDs accept both managed values and
   external reference metadata once configured. The GCP provider ID accepts
   external reference metadata only and remains `coming_soon` for runtime
   resolution until the GCP module ships. The provider health check reports
   any unconfigured provider as a warning.
   ```

2. In the "Provider-Specific Notes" section, replace:

   ```markdown
   **GCP Secret Manager** and **HashiCorp Vault** vaults are coming soon. You can
   save draft `projectId`, `location`, `namespace`, `address`, and `mountPath`
   metadata so the company is ready to flip them on when the provider modules
   ship.
   ```

   with:

   ```markdown
   **HashiCorp Vault / OpenBao** vaults read the per-vault `address`,
   `namespace`, `kvMount`, `kvPathPrefix`, `auth.method` (`kubernetes` or
   `token`), `auth.role`, and `versionRetention`. See
   `doc/SECRETS-VAULT-PROVIDER.md` for the full operational contract,
   required Vault policy, helm-chart OpenBao bundling, and runbooks.

   **GCP Secret Manager** vaults are coming soon. You can save draft
   `projectId`, `location`, and `namespace` metadata so the company is ready
   to flip them on when the GCP provider module ships.
   ```

   Address validation rule stays unchanged (the URL origin-only rule still
   applies to the vault provider).

- [ ] **Step 3: Verify the file still reads cleanly**

Run: `grep -n "coming.soon\|coming_soon\|vault" docs/deploy/secrets.md | head -20`

Expected: no remaining `coming_soon` references for `vault`.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/secrets.md
git commit -m "docs(secrets): deploy/secrets.md — vault provider now ships real"
```

---

## Task 21: Update `docs/api/secrets.md` provider-vault config schema

**Files:**

- Modify: `docs/api/secrets.md`

- [ ] **Step 1: Find the per-provider config-schema section**

Run: `grep -n "Provider vaults\|aws_secrets_manager\|providerConfigId" docs/api/secrets.md | head -20`

- [ ] **Step 2: Add the vault config schema entry**

Find the per-provider config sub-section that documents the AWS vault config
shape; immediately after it, add the vault entry:

```markdown
### Vault Provider Config

`provider = "vault"` config fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `address` | string | yes | Origin-only `http(s)://host[:port]`. No path, query, fragment, or embedded credentials. |
| `namespace` | string | no | Vault Enterprise namespace. Ignored on OpenBao. |
| `kvMount` | string | no | KV mount name; default `secret`. Must not start with `/` or `data/`. |
| `kvPathPrefix` | string | no | Path prefix under the mount; default `paperclip`. |
| `auth.method` | `"kubernetes" \| "token"` | no | Default `kubernetes` in-cluster, `token` locally. |
| `auth.role` | string | conditional | Required when `auth.method = "kubernetes"`. Matches `[A-Za-z0-9_-]{1,128}`. |
| `auth.saTokenPath` | string | no | Default `/var/run/secrets/kubernetes.io/serviceaccount/token`. |
| `versionRetention` | integer | no | Default 10; min 2; max 100. Maps to KV v2 `max_versions`. |

Credential-shaped fields (`token`, `password`, `roleId`, `secretId`,
`unsealKey`, `clientCert`, `privateKey`, `accessKeyId`, `secretAccessKey`,
`serviceAccountJson`, `keyFile`) are rejected at validation time —
bootstrap credentials live in workload identity or `VAULT_TOKEN`, never in
vault config.
```

- [ ] **Step 3: Commit**

```bash
git add docs/api/secrets.md
git commit -m "docs(api): add vault provider config schema"
```

---

## Task 22: Opt-in integration test against `bao server -dev`

**Files:**

- Create: `server/src/__tests__/vault-provider-integration.test.ts`

- [ ] **Step 1: Write the integration test, gated by env**

`server/src/__tests__/vault-provider-integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultProvider, UndiciVaultGateway } from "../secrets/vault-provider.js";

const RUN = process.env.PAPERCLIP_TEST_VAULT === "1";
const ADDR = process.env.PAPERCLIP_TEST_VAULT_ADDR ?? "http://127.0.0.1:8200";
const TOKEN = process.env.PAPERCLIP_TEST_VAULT_TOKEN ?? "root";

describe.skipIf(!RUN)("vault provider — integration (PAPERCLIP_TEST_VAULT=1)", () => {
  beforeAll(() => {
    process.env.VAULT_TOKEN = TOKEN;
  });
  afterAll(() => {
    delete process.env.VAULT_TOKEN;
  });

  function makeProvider() {
    const config = {
      address: ADDR,
      namespace: null,
      kvMount: "secret",
      kvPathPrefix: `paperclip-test-${process.pid}`,
      auth: { method: "token" as const, role: null, saTokenPath: "/dev/null" },
      versionRetention: 5,
    };
    const gateway = new UndiciVaultGateway({
      address: ADDR,
      namespace: null,
      getToken: async () => TOKEN,
    });
    return createVaultProvider({ config, gateway });
  }

  it("create + rotate + resolve(latest) + resolve(version) end-to-end", async () => {
    const provider = makeProvider();
    const ctx = { companyId: "co-int", deploymentId: "test", secretId: "sec-int", secretKey: "INT_KEY", secretName: "INT_KEY", version: 1 };
    const v1 = await provider.createSecret({ value: "value-v1", context: ctx });
    const v2 = await provider.createVersion({ value: "value-v2", context: ctx, externalRef: v1.externalRef });
    expect(v2.providerVersionRef).toBe("2");

    const latest = await provider.resolveVersion({
      material: v2.material,
      externalRef: v2.externalRef,
      context: { companyId: ctx.companyId, secretId: ctx.secretId, secretKey: ctx.secretKey, version: 2 },
    });
    expect(latest).toBe("value-v2");

    const pinned = await provider.resolveVersion({
      material: v1.material,
      externalRef: v1.externalRef,
      providerVersionRef: "1",
      context: { companyId: ctx.companyId, secretId: ctx.secretId, secretKey: ctx.secretKey, version: 1 },
    });
    expect(pinned).toBe("value-v1");

    await provider.deleteOrArchive({
      material: v2.material,
      externalRef: v2.externalRef,
      context: ctx,
      mode: "delete",
    });
  });

  it("retention enforces max_versions = 5", async () => {
    const provider = makeProvider();
    const ctx = { companyId: "co-int", deploymentId: "test", secretId: "sec-ret", secretKey: "RET_KEY", secretName: "RET_KEY", version: 1 };
    const v1 = await provider.createSecret({ value: "v1", context: ctx });
    let ref = v1.externalRef;
    for (let i = 2; i <= 8; i += 1) {
      const r = await provider.createVersion({ value: `v${i}`, context: { ...ctx, version: i - 1 }, externalRef: ref });
      ref = r.externalRef;
    }
    await expect(
      provider.resolveVersion({
        material: v1.material,
        externalRef: ref,
        providerVersionRef: "1",
        context: { companyId: ctx.companyId, secretId: ctx.secretId, secretKey: ctx.secretKey, version: 1 },
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await provider.deleteOrArchive({ material: v1.material, externalRef: ref, context: ctx, mode: "delete" });
  });

  it("health check returns ok against a configured dev bao", async () => {
    const provider = makeProvider();
    const h = await provider.healthCheck();
    expect(["ok", "warn"]).toContain(h.status);
    expect(h.details).toBeTruthy();
  });
});
```

- [ ] **Step 2: Document how to run it**

Run the integration test locally:

```bash
bao server -dev -dev-root-token-id=root &
sleep 1
PAPERCLIP_TEST_VAULT=1 \
PAPERCLIP_TEST_VAULT_ADDR=http://127.0.0.1:8200 \
PAPERCLIP_TEST_VAULT_TOKEN=root \
pnpm -C server vitest run src/__tests__/vault-provider-integration.test.ts
```

Expected: 3 passes when OpenBao (or HashiCorp Vault) is running. Without
`PAPERCLIP_TEST_VAULT=1`, the suite is skipped entirely.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/vault-provider-integration.test.ts
git commit -m "test(secrets): opt-in vault provider integration test (bao -dev)"
```

---

## Final Verification

- [ ] **Run the full server test suite to confirm zero regressions**

Run: `cd server && pnpm vitest run`

Expected: all unit tests green. The integration test in Task 22 is skipped
unless `PAPERCLIP_TEST_VAULT=1` is set.

- [ ] **Type-check the server package**

Run: `cd server && pnpm tsc --noEmit`

Expected: 0 errors.

- [ ] **Lint**

Run: `cd server && pnpm lint`

Expected: 0 errors.

- [ ] **Smoke-check the provider list endpoint behavior is unchanged**

Pull up `server/src/__tests__/secrets-service.test.ts` and confirm no
assertions rely on `vault` being a stub. If any do, update them to reflect
the new `configured: true` descriptor.

If everything is green:

```bash
git log --oneline -25
```

Expected: ~22 commits, one per task, all on the worktree branch stacked on
`feature/credential-broker-m1`.
