import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkStagedCredentialReadiness,
  DeviceLoginReadinessError,
  promoteDeviceLoginCredential,
  type CredentialReadinessResult,
} from "./adapter-auth-promotion.js";
import { MAX_AUTH_JSON_BYTES } from "./device-login-export.js";
import { resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { resolveCodexAuthCacheDir, resolveCodexAuthCacheEntryPath } from "./codex-auth-cache.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const NEWER = "2026-07-09T02:00:00Z";
const OLDER = "2026-07-09T01:00:00Z";
const ACCOUNT = "acct-42";
const OTHER_ACCOUNT = "acct-99";
const TOKEN_SENTINEL = "SENTINEL_TOKEN_XYZ";

// This suite proves the device-login credential promotion helper. The helper
// runs an independent readiness check on the exact staged credential first, then
// validates it with the export rules, then writes this account's own home and,
// as a fallback, the company default home. It writes only while the session
// holds the sole active claim on the slot (the conditional check). It never
// writes the instance-global host, and it never logs secret bytes.
describe("device-login credential promotion", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeInstanceRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-promotion-"));
    cleanupDirs.push(dir);
    return dir;
  }

  function envFor(instanceHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PAPERCLIP_HOME: instanceHome,
      PAPERCLIP_INSTANCE_ID: "default",
      // A fixed shared host home, so a test can assert the helper never writes it.
      CODEX_HOME: path.join(instanceHome, "shared-codex"),
      ...extra,
    };
  }

  function subscriptionAuth(input: {
    accountId: string;
    lastRefresh?: string;
    marker?: string;
  }): Buffer {
    const suffix = input.marker ?? input.accountId;
    return Buffer.from(
      JSON.stringify({
        tokens: {
          id_token: `id-token-${suffix}`,
          access_token: `access-token-${suffix}`,
          refresh_token: `${TOKEN_SENTINEL}-${suffix}`,
          account_id: input.accountId,
        },
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      }),
    );
  }

  const ready = (): CredentialReadinessResult => ({ ready: true });
  const notReady = (): CredentialReadinessResult => ({ ready: false, reason: "auth_unusable" });
  const soleOwner = () => true;
  const noopLog = (_line: string): void => {};

  function companyHomeAuthPath(env: NodeJS.ProcessEnv, companyId: string): string {
    return path.join(resolveManagedCodexHomeDir(env, companyId), "auth.json");
  }

  it("a failed readiness check rejects and writes neither the company home nor the account home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const logs: string[] = [];
    await expect(
      promoteDeviceLoginCredential({
        authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: notReady,
        isSoleActiveOwner: soleOwner,
        env,
        log: (line) => {
          logs.push(line);
        },
      }),
    ).rejects.toBeInstanceOf(DeviceLoginReadinessError);

    // Neither company target was written.
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
    await expect(
      lstat(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A)),
    ).rejects.toThrow();
    // The instance-global host was never touched.
    await expect(
      lstat(path.join(resolveSharedCodexHomeDir(env), "auth.json")),
    ).rejects.toThrow();
    // No secret bytes reached the log.
    expect(logs.join("\n")).not.toContain(TOKEN_SENTINEL);
    expect(logs.join("\n")).not.toContain(ACCOUNT);
  });

  it("a user login seeds this account's own home and the company default home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("promoted");

    const homeAuth = await readFile(companyHomeAuthPath(env, COMPANY_A), "utf8");
    expect(JSON.parse(homeAuth).tokens.account_id).toBe(ACCOUNT);
    const accountAuth = await readFile(
      resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A),
      "utf8",
    );
    expect(JSON.parse(accountAuth).tokens.account_id).toBe(ACCOUNT);
    // The instance-global host was never seeded.
    await expect(
      lstat(path.join(resolveSharedCodexHomeDir(env), "auth.json")),
    ).rejects.toThrow();
  });

  it("a strictly-newer login updates this account's own home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: OLDER, marker: "old" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "new" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("promoted");
    const accountAuth = JSON.parse(
      await readFile(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A), "utf8"),
    );
    expect(accountAuth.last_refresh).toBe(NEWER);
    expect(accountAuth.tokens.refresh_token).toContain("new");
  });

  it("an older login keeps this account's own home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "keep" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: OLDER, marker: "older" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("kept");
    const accountAuth = JSON.parse(
      await readFile(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A), "utf8"),
    );
    expect(accountAuth.tokens.refresh_token).toContain("keep");
  });

  it("promotion writes the account home for a second, different account", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "first" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: OTHER_ACCOUNT, lastRefresh: NEWER, marker: "other" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    // A second, different account gets its own home, so the second login
    // succeeds instead of failing behind the first account's home.
    expect(result.outcome).toBe("promoted");
    const otherAccountAuth = JSON.parse(
      await readFile(resolveCodexAuthCacheEntryPath(env, OTHER_ACCOUNT, COMPANY_A), "utf8"),
    );
    expect(otherAccountAuth.tokens.account_id).toBe(OTHER_ACCOUNT);
  });

  it("promotion returns the account id and the account home path", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.accountId).toBe(ACCOUNT);
    expect(result.accountHomeDir).toBe(
      path.dirname(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A)),
    );
  });

  it("promotion reports accountHomeCreated true for a first login of an account", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("promoted");
    expect(result.accountHomeCreated).toBe(true);
  });

  it("promotion reports accountHomeCreated false for a repeat login of the same account", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: OLDER, marker: "first" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "second" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("promoted");
    expect(result.accountHomeCreated).toBe(false);
  });

  it("two concurrent promotions for the same account report only one accountHomeCreated true", async () => {
    // Two different logins for the SAME Codex account run their own
    // promotion slot, so they can promote at the same time. Without a lock
    // around the absence check and the directory creation, both calls could
    // see the directory as absent and both report `created: true`; a caller
    // that later deletes the directory on `created: true` would then delete
    // a home the other call's login still uses.
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const [first, second] = await Promise.all([
      promoteDeviceLoginCredential({
        authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "racer-a" }),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
      promoteDeviceLoginCredential({
        authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "racer-b" }),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ]);
    // Both racers still authenticate; only the timestamp-comparison outcome
    // (`promoted` vs. `kept`) can differ, because they carry the same
    // `lastRefresh` timestamp.
    expect(["promoted", "kept"]).toContain(first.outcome);
    expect(["promoted", "kept"]).toContain(second.outcome);
    const createdFlags = [first.accountHomeCreated, second.accountHomeCreated];
    expect(createdFlags.filter(Boolean)).toHaveLength(1);
    await expect(
      lstat(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A)),
    ).resolves.toBeDefined();
  });

  it("promotion keeps the company default home when it holds another account", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "first" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    const before = await readFile(companyHomeAuthPath(env, COMPANY_A), "utf8");
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: OTHER_ACCOUNT, lastRefresh: NEWER, marker: "other" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    // The company default home fallback still names the first account: a
    // second account never clobbers it once some account has claimed it.
    expect(await readFile(companyHomeAuthPath(env, COMPANY_A), "utf8")).toBe(before);
  });

  it("promotion seeds the company default home when it holds no usable credential", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("promoted");
    const homeAuth = await readFile(companyHomeAuthPath(env, COMPANY_A), "utf8");
    expect(JSON.parse(homeAuth).tokens.account_id).toBe(ACCOUNT);
  });

  it("promotion fails the login when the account identifier cannot become a handle", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await expect(
      promoteDeviceLoginCredential({
        authBytes: subscriptionAuth({ accountId: "acct 42", lastRefresh: NEWER }),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ).rejects.toThrow();
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
  });

  it("a whitespace-padded account identifier never shares a home with, or reports as authenticated against, the unpadded account", async () => {
    // A distinct identifier with surrounding whitespace must reject, not
    // alias onto the unpadded account's home. Promote the unpadded account
    // first, then attempt a second login whose identifier differs only by a
    // leading space. The second login must fail, and it must never read or
    // report a "kept" outcome against the first account's home.
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "original" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    await expect(
      promoteDeviceLoginCredential({
        authBytes: subscriptionAuth({ accountId: ` ${ACCOUNT}`, lastRefresh: NEWER, marker: "padded" }),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ).rejects.toThrow();
    // The unpadded account's home still holds only the credential the first
    // login wrote. The padded login never read it, never wrote it, and never
    // received a "kept" outcome that would report it as authenticated.
    const accountAuth = JSON.parse(
      await readFile(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A), "utf8"),
    );
    expect(accountAuth.tokens.refresh_token).toContain("original");
  });

  it("a broken account-home directory fails the whole login", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    // Force this account's own home write to fail. Plant a regular file where
    // the account expects its own directory, so the private-directory guard
    // throws before any write. That write is now fail-loud (it is the durable
    // result), so the whole login fails, and the best-effort company default
    // home fallback is never reached.
    const cacheDir = resolveCodexAuthCacheDir(env, COMPANY_A);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const entryPath = resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A);
    await writeFile(path.dirname(entryPath), "not-a-directory");

    await expect(
      promoteDeviceLoginCredential({
        authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
        companyId: COMPANY_A,
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ).rejects.toThrow();
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
  });

  it("a company default home write failure keeps the promotion successful and this account's own home durable", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    // Force the company default home write to fail. Plant a regular file where
    // the company home directory belongs, so mkdir fails. This account's own
    // home write already ran and is durable, so the login still succeeds.
    const companyHome = resolveManagedCodexHomeDir(env, COMPANY_A);
    await mkdir(path.dirname(companyHome), { recursive: true });
    await writeFile(companyHome, "not-a-directory");

    const logs: string[] = [];
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: (line) => {
        logs.push(line);
      },
    });

    expect(result.outcome).toBe("promoted");
    const accountAuth = JSON.parse(
      await readFile(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A), "utf8"),
    );
    expect(accountAuth.tokens.account_id).toBe(ACCOUNT);
    const haystack = logs.join("\n");
    expect(haystack).toContain("seeding the company default home failed");
    expect(haystack).not.toContain(TOKEN_SENTINEL);
    expect(haystack).not.toContain(ACCOUNT);
  });

  it("rejects malformed, API-key, non-subscription, and oversized credentials and writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const malformed = Buffer.from("this is not json {");
    const apiKey = Buffer.from(JSON.stringify({ OPENAI_API_KEY: "sk-secret-key" }));
    const nonSubscription = Buffer.from(JSON.stringify({ tokens: { account_id: "" } }));
    const oversized = Buffer.concat([
      subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      Buffer.alloc(MAX_AUTH_JSON_BYTES + 10, 0x20),
    ]);
    for (const bytes of [malformed, apiKey, nonSubscription, oversized]) {
      await expect(
        promoteDeviceLoginCredential({
          authBytes: bytes,
          companyId: COMPANY_A,
          userInitiated: true,
          checkReadiness: ready,
          isSoleActiveOwner: soleOwner,
          env,
          log: noopLog,
        }),
      ).rejects.toThrow();
    }
    // No company target and no instance-global host was written.
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
    await expect(
      lstat(path.join(resolveSharedCodexHomeDir(env), "auth.json")),
    ).rejects.toThrow();
  });

  it("a promotion whose session is no longer the sole active owner writes nothing", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      // The session lost the active claim on the slot.
      isSoleActiveOwner: () => false,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("not_sole_owner");
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
    await expect(
      lstat(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A)),
    ).rejects.toThrow();
  });

  it("an automatic background login never seeds an empty home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const result = await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      // Not a user-initiated login.
      userInitiated: false,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(result.outcome).toBe("background_skipped");
    await expect(lstat(companyHomeAuthPath(env, COMPANY_A))).rejects.toThrow();
    await expect(
      lstat(resolveCodexAuthCacheEntryPath(env, ACCOUNT, COMPANY_A)),
    ).rejects.toThrow();
  });

  it("a Company A login never changes a Company B credential", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    // Seed Company B first.
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: OLDER, marker: "b-cred" }),
      companyId: COMPANY_B,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    const before = await readFile(companyHomeAuthPath(env, COMPANY_B), "utf8");

    // A Company A login for the same identity, even newer, must not touch B.
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER, marker: "a-cred" }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: noopLog,
    });
    expect(await readFile(companyHomeAuthPath(env, COMPANY_B), "utf8")).toBe(before);
    const aHome = JSON.parse(await readFile(companyHomeAuthPath(env, COMPANY_A), "utf8"));
    expect(aHome.tokens.refresh_token).toContain("a-cred");
  });

  it("the promotion log never contains token bytes or a raw account_id", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    const logs: string[] = [];
    await promoteDeviceLoginCredential({
      authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
      companyId: COMPANY_A,
      userInitiated: true,
      checkReadiness: ready,
      isSoleActiveOwner: soleOwner,
      env,
      log: (line) => {
          logs.push(line);
        },
    });
    const haystack = logs.join("\n");
    expect(haystack).not.toContain(TOKEN_SENTINEL);
    expect(haystack).not.toContain(ACCOUNT);
  });

  it("rejects an empty companyId, so a promotion can never reach the instance-global home", async () => {
    const home = await makeInstanceRoot();
    const env = envFor(home);
    await expect(
      promoteDeviceLoginCredential({
        authBytes: subscriptionAuth({ accountId: ACCOUNT, lastRefresh: NEWER }),
        companyId: "",
        userInitiated: true,
        checkReadiness: ready,
        isSoleActiveOwner: soleOwner,
        env,
        log: noopLog,
      }),
    ).rejects.toThrow();
    // The instance-global codex-home was never seeded.
    await expect(
      lstat(path.join(resolveManagedCodexHomeDir(env), "auth.json")),
    ).rejects.toThrow();
  });
});

// This suite proves the independent readiness check for a staged credential. It
// answers whether a run launched now with the exact staged bytes would
// authenticate. It writes the bytes to a throwaway home only, and it never reads
// or writes any company scope.
describe("staged credential readiness", () => {
  it("returns ready for a usable subscription credential", async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        tokens: {
          id_token: "id-token",
          access_token: "access-token",
          refresh_token: "refresh-token",
          account_id: "acct-1",
        },
      }),
    );
    const result = await checkStagedCredentialReadiness(bytes);
    expect(result.ready).toBe(true);
  });

  it("returns not ready for empty bytes", async () => {
    const result = await checkStagedCredentialReadiness(Buffer.alloc(0));
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("empty_credential");
  });

  it("returns not ready for a credential with no usable auth payload", async () => {
    const result = await checkStagedCredentialReadiness(
      Buffer.from(JSON.stringify({ tokens: { account_id: "acct-1" } })),
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("no_usable_auth");
  });

  it("returns not ready for malformed bytes", async () => {
    const result = await checkStagedCredentialReadiness(Buffer.from("not-json"));
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("no_usable_auth");
  });
});
