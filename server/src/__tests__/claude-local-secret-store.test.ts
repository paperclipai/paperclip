import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EncryptedFileSecretStore,
  createDefaultSecretStore,
  createTokenResolverWithSecretStore,
  defaultTokenResolver,
  initMasterKey,
  parseClaudeLocalGitConfig,
  parseSecretsRef,
  prepareGitIdentityRuntime,
  SECRET_STORE_SELECTOR_ENV,
  SECRETS_REF_SCHEME,
} from "@paperclipai/adapter-claude-local/server";

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-secrets-test-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("parseClaudeLocalGitConfig accepts secrets:// scheme", () => {
  it("accepts a valid config with a secrets:// tokenSecretRef", () => {
    const result = parseClaudeLocalGitConfig({
      userName: "paperclip-foundingeng",
      userEmail: "paperclip+foundingeng@openstudio.fr",
      tokenSecretRef: `${SECRETS_REF_SCHEME}gh/paperclip-foundingeng`,
    });
    expect(result.errors).toEqual([]);
    expect(result.config?.tokenSecretRef).toBe(`${SECRETS_REF_SCHEME}gh/paperclip-foundingeng`);
  });

  it("rejects a secrets:// ref with an empty key", () => {
    const result = parseClaudeLocalGitConfig({
      userName: "x",
      userEmail: "x@y.com",
      tokenSecretRef: SECRETS_REF_SCHEME,
    });
    expect(result.config).toBeNull();
    expect(result.errors.find((e) => e.field === "tokenSecretRef")).toBeDefined();
  });

  it("rejects a secrets:// ref with a path-traversal key", () => {
    const result = parseClaudeLocalGitConfig({
      userName: "x",
      userEmail: "x@y.com",
      tokenSecretRef: `${SECRETS_REF_SCHEME}../etc/passwd`,
    });
    expect(result.config).toBeNull();
    expect(result.errors.find((e) => e.field === "tokenSecretRef")).toBeDefined();
  });
});

describe("parseSecretsRef", () => {
  it("strips the secrets:// scheme", () => {
    expect(parseSecretsRef("secrets://gh/paperclip-foundingeng")).toBe("gh/paperclip-foundingeng");
    expect(parseSecretsRef("secrets://flat-key")).toBe("flat-key");
  });

  it("rejects non-secrets refs", () => {
    expect(parseSecretsRef("env:FOO")).toBeNull();
    expect(parseSecretsRef("file:/abs/path")).toBeNull();
    expect(parseSecretsRef("")).toBeNull();
  });

  it("rejects unsafe keys (path traversal, absolute, backslash, null byte)", () => {
    expect(parseSecretsRef("secrets://../etc/passwd")).toBeNull();
    expect(parseSecretsRef("secrets:///etc/shadow")).toBeNull();
    expect(parseSecretsRef("secrets://foo\\bar")).toBeNull();
    expect(parseSecretsRef("secrets://foo\0bar")).toBeNull();
    expect(parseSecretsRef("secrets://   ")).toBeNull();
  });
});

describe("EncryptedFileSecretStore round-trip", () => {
  it("encrypts then decrypts a secret with libsodium-equivalent crypto_secretbox", async () => {
    await withTempRoot(async (root) => {
      const init = await initMasterKey({ rootDir: root });
      expect(init.created).toBe(true);
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      const ref = `${SECRETS_REF_SCHEME}gh/example`;
      await store.put(ref, "ghp_super_secret_pat_value_zzz");
      const resolved = await store.resolve(ref);
      expect(resolved).toBe("ghp_super_secret_pat_value_zzz");

      // Re-running put with the same key overwrites without error.
      await store.put(ref, "ghp_rotated_value");
      expect(await store.resolve(ref)).toBe("ghp_rotated_value");

      // list shows the key
      expect(await store.list()).toContain("gh/example");

      // delete removes it
      await store.delete(ref);
      expect(await store.list()).not.toContain("gh/example");
      expect(await store.resolve(ref)).toBeNull();
    });
  });

  it("isolates two companies into distinct files under the same root", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const a = new EncryptedFileSecretStore({ companyId: "co-a", rootDir: root });
      const b = new EncryptedFileSecretStore({ companyId: "co-b", rootDir: root });
      await a.put("gh/svc", "pat-a-aaaaaaaa");
      await b.put("gh/svc", "pat-b-bbbbbbbb");
      expect(await a.resolve(`${SECRETS_REF_SCHEME}gh/svc`)).toBe("pat-a-aaaaaaaa");
      expect(await b.resolve(`${SECRETS_REF_SCHEME}gh/svc`)).toBe("pat-b-bbbbbbbb");
      const stat = await fs.stat(a.secretsFilePath);
      const stat2 = await fs.stat(b.secretsFilePath);
      expect(a.secretsFilePath).not.toBe(b.secretsFilePath);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat2.mode & 0o777).toBe(0o600);
      }
    });
  });

  it("returns null for an unknown key (no throw, no fallthrough)", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      expect(await store.resolve(`${SECRETS_REF_SCHEME}does-not-exist`)).toBeNull();
      expect(await store.list()).toEqual([]);
    });
  });

  it("returns null when called with a non-secrets ref (caller should layer with other resolvers)", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      expect(await store.resolve("env:FOO")).toBeNull();
      expect(await store.resolve("file:/etc/passwd")).toBeNull();
    });
  });
});

describe("EncryptedFileSecretStore boot-check (master key permissions)", () => {
  if (process.platform === "win32") {
    it.skip("POSIX-only: skipped on Windows", () => undefined);
    return;
  }

  it("refuses to read the master key when mode is not 0600", async () => {
    await withTempRoot(async (root) => {
      const init = await initMasterKey({ rootDir: root });
      // Loosen the permissions and confirm the boot check fires.
      await fs.chmod(init.path, 0o644);
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      await store.put.bind(store);
      await expect(store.resolve(`${SECRETS_REF_SCHEME}whatever`)).rejects.toThrow(/unsafe permissions/);
      await expect(store.put(`${SECRETS_REF_SCHEME}any`, "v")).rejects.toThrow(/unsafe permissions/);
    });
  });

  it("refuses to read the secrets file when mode is not 0600", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      await store.put(`${SECRETS_REF_SCHEME}gh/svc`, "v");
      await fs.chmod(store.secretsFilePath, 0o644);
      await expect(store.resolve(`${SECRETS_REF_SCHEME}gh/svc`)).rejects.toThrow(/unsafe permissions/);
    });
  });
});

describe("EncryptedFileSecretStore corruption detection", () => {
  it("throws a clear error when ciphertext is tampered with", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      await store.put(`${SECRETS_REF_SCHEME}gh/svc`, "pat-valid");
      const raw = JSON.parse(await fs.readFile(store.secretsFilePath, "utf8")) as {
        entries: Record<string, { nonce: string; ciphertext: string }>;
      };
      // Flip a single byte in the middle of the ciphertext (after base64-decoding)
      // so the Poly1305 tag verification fails. Tampering the last base64 char can
      // sometimes flip only padding bits and decode back to the same bytes.
      const original = Buffer.from(raw.entries["gh/svc"].ciphertext, "base64");
      const mid = Math.floor(original.length / 2);
      original[mid] = original[mid] ^ 0x01;
      raw.entries["gh/svc"].ciphertext = original.toString("base64");
      await fs.writeFile(store.secretsFilePath, JSON.stringify(raw, null, 2), { mode: 0o600 });
      await fs.chmod(store.secretsFilePath, 0o600);
      await expect(store.resolve(`${SECRETS_REF_SCHEME}gh/svc`)).rejects.toThrow(/failed to decrypt/);
    });
  });

  it("throws a clear error when the file is not valid JSON", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      await store.put(`${SECRETS_REF_SCHEME}gh/svc`, "v");
      await fs.writeFile(store.secretsFilePath, "{not-json", { mode: 0o600 });
      await fs.chmod(store.secretsFilePath, 0o600);
      await expect(store.resolve(`${SECRETS_REF_SCHEME}gh/svc`)).rejects.toThrow(/invalid JSON/);
    });
  });
});

describe("initMasterKey", () => {
  it("is idempotent and refuses to overwrite an existing key", async () => {
    await withTempRoot(async (root) => {
      const a = await initMasterKey({ rootDir: root });
      expect(a.created).toBe(true);
      const original = await fs.readFile(a.path);
      const b = await initMasterKey({ rootDir: root });
      expect(b.created).toBe(false);
      const after = await fs.readFile(a.path);
      expect(Buffer.compare(original, after)).toBe(0);
    });
  });

  it("creates the master key with mode 0600", async () => {
    if (process.platform === "win32") return;
    await withTempRoot(async (root) => {
      const r = await initMasterKey({ rootDir: root });
      const stat = await fs.stat(r.path);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.size).toBe(32);
    });
  });
});

describe("createDefaultSecretStore selector", () => {
  it("returns an EncryptedFileSecretStore by default", () => {
    const store = createDefaultSecretStore({ companyId: "co-default", env: {} });
    expect(store).toBeInstanceOf(EncryptedFileSecretStore);
  });

  it("returns an EncryptedFileSecretStore when selector=file", () => {
    const store = createDefaultSecretStore({
      companyId: "co-default",
      env: { [SECRET_STORE_SELECTOR_ENV]: "file" },
    });
    expect(store).toBeInstanceOf(EncryptedFileSecretStore);
  });

  it("throws loudly on an unknown selector (no silent fallback)", () => {
    expect(() =>
      createDefaultSecretStore({
        companyId: "co-default",
        env: { [SECRET_STORE_SELECTOR_ENV]: "vault" },
      }),
    ).toThrow(/not supported/);
  });
});

describe("createTokenResolverWithSecretStore", () => {
  it("falls back to env:/file: resolution for non-secrets refs", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-test", rootDir: root });
      await store.put(`${SECRETS_REF_SCHEME}gh/svc`, "from-secrets-store");

      const resolver = createTokenResolverWithSecretStore(store);
      process.env._PAPERCLIP_TEST_TOKEN_RESOLVER = "from-env-var";
      try {
        expect(await resolver("env:_PAPERCLIP_TEST_TOKEN_RESOLVER")).toBe("from-env-var");
        expect(await resolver(`${SECRETS_REF_SCHEME}gh/svc`)).toBe("from-secrets-store");
        expect(await resolver(`${SECRETS_REF_SCHEME}unknown`)).toBeNull();
      } finally {
        delete process.env._PAPERCLIP_TEST_TOKEN_RESOLVER;
      }
    });
  });

  it("returns the bare defaultTokenResolver when no store is provided", async () => {
    const resolver = createTokenResolverWithSecretStore(null);
    expect(resolver).toBe(defaultTokenResolver);
  });
});

describe("prepareGitIdentityRuntime end-to-end with secrets:// scheme", () => {
  it("resolves a secrets:// PAT and injects it as GH_TOKEN without writing it to .gitconfig", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-fe", rootDir: root });
      const SECRET_PAT = "ghp_secrets_store_resolved_aaaaaaaa";
      await store.put(`${SECRETS_REF_SCHEME}gh/paperclip-foundingeng`, SECRET_PAT);
      const resolver = createTokenResolverWithSecretStore(store);

      const result = await prepareGitIdentityRuntime({
        runId: "run-secrets-e2e",
        agentId: "agent-fe",
        cwd: root,
        config: {
          userName: "paperclip-foundingeng",
          userEmail: "paperclip+foundingeng@openstudio.fr",
          tokenSecretRef: `${SECRETS_REF_SCHEME}gh/paperclip-foundingeng`,
        },
        resolveToken: resolver,
        runtimeRoot: path.join(root, "git-identity-runtime"),
      });
      try {
        expect(result.env.GH_TOKEN).toBe(SECRET_PAT);
        const body = await fs.readFile(result.gitConfigPath, "utf8");
        // The literal PAT must NOT appear in the gitconfig; the helper references $GH_TOKEN.
        expect(body).not.toContain(SECRET_PAT);
        expect(body).toContain("$GH_TOKEN");
      } finally {
        await result.cleanup();
      }
    });
  });

  it("warns and skips GH_TOKEN injection when a secrets:// key is missing", async () => {
    await withTempRoot(async (root) => {
      await initMasterKey({ rootDir: root });
      const store = new EncryptedFileSecretStore({ companyId: "co-fe", rootDir: root });
      const resolver = createTokenResolverWithSecretStore(store);

      const result = await prepareGitIdentityRuntime({
        runId: "run-secrets-missing",
        agentId: "agent-fe",
        cwd: root,
        config: {
          userName: "x",
          userEmail: "x@y.com",
          tokenSecretRef: `${SECRETS_REF_SCHEME}does-not-exist`,
        },
        resolveToken: resolver,
        runtimeRoot: path.join(root, "git-identity-runtime"),
      });
      try {
        expect(result.env.GH_TOKEN).toBeUndefined();
        expect(result.warnings.length).toBeGreaterThan(0);
        const body = await fs.readFile(result.gitConfigPath, "utf8");
        expect(body).not.toContain("https://github.com"); // no credential helper without a resolved token
      } finally {
        await result.cleanup();
      }
    });
  });
});
