import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyBackCodexAuth } from "./codex-auth-copyback.js";
import {
  ensureCodexAuthCacheEntryDir,
  resolveCodexAuthCacheDir,
  resolveCodexAuthCacheEntryPath,
} from "./codex-auth-cache.js";
import { resolveSharedCodexHomeDir } from "./codex-home.js";

// The copy-back module reuses the exact same direction-agnostic decision
// predicate (`codex-auth-merge-decision.cjs`) that the inbound extract path
// runs, only with the arguments flipped: for an outbound copy-back the sandbox
// copy is the `source` and the host copy is the `destination`, so exit 10
// (use source) means "install the sandbox credential onto the host" and exit 20
// (keep destination) means "leave the host credential untouched". This suite
// drives the REAL `.cjs` through the module (no stub predicate) against a real
// host tmp filesystem, injecting only the sandbox read.
describe("copyBackCodexAuth", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      // Re-open perms in case a test tightened them, so cleanup always succeeds.
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: {
    accountId: string;
    lastRefresh?: string;
    marker: string;
  }): string {
    return JSON.stringify(
      {
        tokens: {
          id_token: `id-token-${input.marker}`,
          access_token: `access-token-${input.marker}`,
          refresh_token: `refresh-token-${input.marker}`,
          account_id: input.accountId,
        },
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      },
      null,
      2,
    );
  }

  function apiKeyAuth(marker: string): string {
    return JSON.stringify({ OPENAI_API_KEY: `sk-${marker}` }, null, 2);
  }

  async function makeHostDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-copyback-"));
    cleanupDirs.push(dir);
    return dir;
  }

  const NEWER = "2026-07-09T02:00:00Z";
  const OLDER = "2026-07-09T01:00:00Z";

  async function runCopyBack(input: {
    sandboxAuth: string | (() => Promise<Buffer>);
    hostAuth: string;
    hostDir?: string;
  }): Promise<{
    outcome: Awaited<ReturnType<typeof copyBackCodexAuth>>;
    finalHostAuth: string;
    finalHostMode: number;
    logs: string[];
    leftoverEntries: string[];
  }> {
    const hostDir = input.hostDir ?? (await makeHostDir());
    const hostAuthPath = path.join(hostDir, "auth.json");
    await writeFile(hostAuthPath, input.hostAuth, { mode: 0o600 });

    const readSandboxAuth =
      typeof input.sandboxAuth === "function"
        ? input.sandboxAuth
        : async () => Buffer.from(input.sandboxAuth as string, "utf8");

    const logs: string[] = [];
    const outcome = await copyBackCodexAuth({
      readSandboxAuth,
      hostAuthPath,
      log: (line) => {
        logs.push(line);
      },
    });

    const finalHostAuth = await readFile(hostAuthPath, "utf8");
    const finalHostMode = (await lstat(hostAuthPath)).mode & 0o777;
    const leftoverEntries = (await readdir(hostDir)).filter((name) => name !== "auth.json");
    return { outcome, finalHostAuth, finalHostMode, logs, leftoverEntries };
  }

  it("installs a strictly-newer same-account sandbox auth onto the host at 0600", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: NEWER,
      marker: "sandbox-newer-SENTINEL",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: OLDER,
      marker: "host-older-SENTINEL",
    });

    const result = await runCopyBack({ sandboxAuth, hostAuth });

    expect(result.outcome).toBe("copied");
    expect(result.finalHostAuth).toBe(sandboxAuth);
    expect(result.finalHostMode).toBe(0o600);
    // Temp staging file must be gone once the swap completes.
    expect(result.leftoverEntries).toEqual([]);
    // Never leak token bytes in log output.
    expect(result.logs.join("\n")).not.toContain("SENTINEL");
  });

  it("keeps the host auth when the sandbox copy is not strictly newer", async () => {
    const cases: { name: string; sandboxAuth: string; hostAuth: string }[] = [
      {
        name: "tie",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: NEWER, marker: "sandbox-tie" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: NEWER, marker: "host-tie" }),
      },
      {
        name: "sandbox older",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: OLDER, marker: "sandbox-older" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: NEWER, marker: "host-newer" }),
      },
      {
        name: "missing sandbox last_refresh",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", marker: "sandbox-no-refresh" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: NEWER, marker: "host-refresh" }),
      },
      {
        name: "unparseable sandbox last_refresh",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "not-a-date", marker: "sandbox-bad" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: NEWER, marker: "host-refresh" }),
      },
    ];

    for (const entry of cases) {
      const result = await runCopyBack({ sandboxAuth: entry.sandboxAuth, hostAuth: entry.hostAuth });
      expect(result.outcome, entry.name).toBe("kept-host");
      expect(result.finalHostAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalHostMode, entry.name).toBe(0o600);
      expect(result.leftoverEntries, entry.name).toEqual([]);
    }
  });

  it("keeps the host auth on identity mismatch, kind mismatch, apikey, and unusable sandbox auth", async () => {
    const hostAuth = subscriptionAuth({ accountId: "acct-host", lastRefresh: OLDER, marker: "host-keep" });
    const cases: { name: string; sandboxAuth: string; hostAuth: string }[] = [
      {
        name: "identity mismatch (sandbox newer, different account)",
        sandboxAuth: subscriptionAuth({ accountId: "acct-other", lastRefresh: NEWER, marker: "sandbox-other" }),
        hostAuth,
      },
      {
        name: "kind mismatch (sandbox subscription, host apikey)",
        sandboxAuth: subscriptionAuth({ accountId: "acct-host", lastRefresh: NEWER, marker: "sandbox-sub" }),
        hostAuth: apiKeyAuth("host-api-key"),
      },
      {
        name: "sandbox apikey",
        sandboxAuth: apiKeyAuth("sandbox-api-key"),
        hostAuth,
      },
      {
        name: "sandbox unusable JSON",
        sandboxAuth: "{not valid json",
        hostAuth,
      },
      {
        name: "sandbox account id missing",
        sandboxAuth: JSON.stringify({
          tokens: { id_token: "id", access_token: "acc", refresh_token: "ref" },
          last_refresh: NEWER,
        }),
        hostAuth,
      },
      {
        name: "host unusable JSON (never create host auth from sandbox)",
        sandboxAuth: subscriptionAuth({ accountId: "acct-host", lastRefresh: NEWER, marker: "sandbox-valid" }),
        hostAuth: "{not valid json",
      },
    ];

    for (const entry of cases) {
      const result = await runCopyBack({ sandboxAuth: entry.sandboxAuth, hostAuth: entry.hostAuth });
      expect(result.outcome, entry.name).toBe("kept-host");
      expect(result.finalHostAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalHostMode, entry.name).toBe(0o600);
      expect(result.leftoverEntries, entry.name).toEqual([]);
    }
  });

  it("creates a missing shared Codex home before staging copy-back", async () => {
    const rootDir = await makeHostDir();
    const hostDir = path.join(rootDir, "missing-codex-home");
    const hostAuthPath = path.join(hostDir, "auth.json");
    const logs: string[] = [];

    const outcome = await copyBackCodexAuth({
      readSandboxAuth: async () => Buffer.from(apiKeyAuth("sandbox-only"), "utf8"),
      hostAuthPath,
      log: (line) => {
        logs.push(line);
      },
    });

    expect(outcome).toBe("kept-host");
    expect(await readdir(hostDir)).toEqual([]);
    expect(logs.join("\n")).not.toContain("sandbox-only");
  });

  it("preserves the host file atomically when the install cannot be staged (no partial write, no leaked temp)", async () => {
    // Make the host directory read-only so staging the same-filesystem temp fails
    // with EACCES. The host credential must be left byte-for-byte intact and no
    // partial/temp file may remain — the outbound write is all-or-nothing.
    const hostDir = await makeHostDir();
    const hostAuth = subscriptionAuth({ accountId: "acct-same", lastRefresh: OLDER, marker: "host-intact" });
    const hostAuthPath = path.join(hostDir, "auth.json");
    await writeFile(hostAuthPath, hostAuth, { mode: 0o600 });
    const before = await stat(hostAuthPath);

    await chmod(hostDir, 0o500); // r-x: readable/traversable, not writable
    try {
      const sandboxAuth = subscriptionAuth({ accountId: "acct-same", lastRefresh: NEWER, marker: "sandbox-newer" });
      await expect(
        copyBackCodexAuth({
          readSandboxAuth: async () => Buffer.from(sandboxAuth, "utf8"),
          hostAuthPath,
          log: () => {},
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(hostDir, 0o700);
    }

    const after = await stat(hostAuthPath);
    expect(await readFile(hostAuthPath, "utf8")).toBe(hostAuth);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await readdir(hostDir)).filter((name) => name !== "auth.json")).toEqual([]);
  });

  it("treats an absent sandbox auth.json (ENOENT) as a keep-host no-op, host untouched, no throw", async () => {
    const hostAuth = subscriptionAuth({ accountId: "acct-same", lastRefresh: OLDER, marker: "host-intact" });

    // The real production `readSandboxAuth` is `readFile("${assetDir}/auth.json")`;
    // a genuinely absent file surfaces a node ENOENT error. That must be a benign
    // "nothing to copy back" outcome, not a fail-loud teardown error.
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'auth.json'"), {
      code: "ENOENT",
    });

    const result = await runCopyBack({
      sandboxAuth: async () => {
        throw enoent;
      },
      hostAuth,
    });

    expect(result.outcome).toBe("kept-host");
    expect(result.finalHostAuth).toBe(hostAuth);
    expect(result.finalHostMode).toBe(0o600);
    // No staging temp is ever created on the ENOENT path.
    expect(result.leftoverEntries).toEqual([]);
    expect(result.logs.join("\n")).toContain("no sandbox credential to copy back");
  });

  it("fails loud when the sandbox read errors and leaves the host untouched", async () => {
    const hostDir = await makeHostDir();
    const hostAuth = subscriptionAuth({ accountId: "acct-same", lastRefresh: OLDER, marker: "host-intact" });
    const hostAuthPath = path.join(hostDir, "auth.json");
    await writeFile(hostAuthPath, hostAuth, { mode: 0o600 });

    await expect(
      copyBackCodexAuth({
        readSandboxAuth: async () => {
          throw new Error("sandbox read boom");
        },
        hostAuthPath,
        log: () => {},
      }),
    ).rejects.toThrow(/sandbox read boom/);

    expect(await readFile(hostAuthPath, "utf8")).toBe(hostAuth);
    expect((await readdir(hostDir)).filter((name) => name !== "auth.json")).toEqual([]);
  });

  it("does not emit token substrings on any code path", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: NEWER,
      marker: "TOKEN-SENTINEL",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: OLDER,
      marker: "HOST-SENTINEL",
    });

    const result = await runCopyBack({ sandboxAuth, hostAuth });
    expect(result.outcome).toBe("copied");
    const combined = result.logs.join("\n");
    expect(combined).not.toContain("SENTINEL");
    expect(combined).not.toContain("id-token");
    expect(combined).not.toContain("access-token");
    expect(combined).not.toContain("refresh-token");
  });
});

// The teardown copy-back also writes the fresher, usable subscription credential
// into its per-identity cache slot, keyed by the real `account_id`. The cache is
// a SEPARATE store; the host default overwrite and the cache slot are asserted
// independently. This suite drives the real `.cjs` predicate (default mode for
// the host store, seed mode for the cache slot) against a real host tmp
// filesystem.
describe("copyBackCodexAuth identity-keyed cache write", () => {
  const cleanupDirs: string[] = [];
  const COMPANY_ID = "company-a";

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: { accountId: string; lastRefresh?: string; marker: string }): string {
    return JSON.stringify({
      tokens: {
        id_token: `id-token-${input.marker}`,
        access_token: `access-token-${input.marker}`,
        refresh_token: `refresh-token-${input.marker}`,
        account_id: input.accountId,
      },
      ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
    });
  }

  function apiKeyAuth(marker: string): string {
    return JSON.stringify({ OPENAI_API_KEY: `sk-${marker}` });
  }

  const NEWER = "2026-07-09T02:00:00Z";
  const OLDER = "2026-07-09T01:00:00Z";

  async function makeEnv(extra: Record<string, string> = {}): Promise<{
    env: NodeJS.ProcessEnv;
    sharedHomeAuthPath: string;
    sharedHome: string;
  }> {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-copyback-cache-"));
    cleanupDirs.push(home);
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: home,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: path.join(home, "shared-codex"),
      ...extra,
    };
    const sharedHome = resolveSharedCodexHomeDir(env);
    await mkdir(sharedHome, { recursive: true });
    return { env, sharedHomeAuthPath: path.join(sharedHome, "auth.json"), sharedHome };
  }

  async function runWithCache(input: {
    sandboxAuth: string;
    hostAuth?: string;
    env: NodeJS.ProcessEnv;
    sharedHomeAuthPath: string;
    cacheEnabledEnv?: NodeJS.ProcessEnv;
  }): Promise<{
    outcome: Awaited<ReturnType<typeof copyBackCodexAuth>>;
    finalHostAuth: string | null;
    logs: string[];
  }> {
    if (input.hostAuth !== undefined) {
      await writeFile(input.sharedHomeAuthPath, input.hostAuth, { mode: 0o600 });
    }
    const logs: string[] = [];
    const outcome = await copyBackCodexAuth({
      readSandboxAuth: async () => Buffer.from(input.sandboxAuth, "utf8"),
      hostAuthPath: input.sharedHomeAuthPath,
      log: (line) => {
        logs.push(line);
      },
      resolveCacheEntryPath: (accountId) =>
        ensureCodexAuthCacheEntryDir(input.env, accountId, COMPANY_ID),
      env: input.cacheEnabledEnv ?? input.env,
    });
    const finalHostAuth = await readFile(input.sharedHomeAuthPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)),
    );
    return { outcome, finalHostAuth, logs };
  }

  async function readCacheSlot(env: NodeJS.ProcessEnv, accountId: string): Promise<string | null> {
    const entryPath = resolveCodexAuthCacheEntryPath(env, accountId, COMPANY_ID);
    return readFile(entryPath, "utf8").catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    );
  }

  it("host absent (matrix row 3): host default store stays empty, cache slot holds the credential keyed by account_id", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    const sandboxAuth = subscriptionAuth({ accountId: "acct-y", lastRefresh: NEWER, marker: "row3" });

    const result = await runWithCache({ sandboxAuth, env, sharedHomeAuthPath });

    expect(result.outcome).toBe("kept-host");
    expect(result.finalHostAuth).toBeNull(); // host never seeded
    expect(await readCacheSlot(env, "acct-y")).toBe(sandboxAuth);
  });

  it("host present, same identity, sandbox newer (matrix row 1a): host default overwritten AND cache slot updated", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    const sandboxAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: NEWER, marker: "sandbox" });
    const hostAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" });

    const result = await runWithCache({ sandboxAuth, hostAuth, env, sharedHomeAuthPath });

    expect(result.outcome).toBe("copied");
    expect(result.finalHostAuth).toBe(sandboxAuth);
    expect(await readCacheSlot(env, "acct-x")).toBe(sandboxAuth);
  });

  it("host present, different identity (matrix row 1b): host default untouched, cache slot holds the new identity only", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    const sandboxAuth = subscriptionAuth({ accountId: "acct-y", lastRefresh: NEWER, marker: "sandbox" });
    const hostAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" });

    const result = await runWithCache({ sandboxAuth, hostAuth, env, sharedHomeAuthPath });

    expect(result.outcome).toBe("kept-host");
    expect(result.finalHostAuth).toBe(hostAuth); // host keeps its own identity X
    expect(await readCacheSlot(env, "acct-y")).toBe(sandboxAuth); // slot Y written
    expect(await readCacheSlot(env, "acct-x")).toBeNull(); // no slot for host identity
  });

  it("sandbox apikey or unusable: neither the host default nor the cache changes", async () => {
    for (const sandboxAuth of [apiKeyAuth("sbx"), "{not valid json"]) {
      const { env, sharedHomeAuthPath } = await makeEnv();
      const hostAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" });
      const result = await runWithCache({ sandboxAuth, hostAuth, env, sharedHomeAuthPath });
      expect(result.outcome).toBe("kept-host");
      expect(result.finalHostAuth).toBe(hostAuth);
      const cacheDir = resolveCodexAuthCacheDir(env, COMPANY_ID);
      // No cache slot directory is created at all for a credential with no identity.
      await expect(readdir(cacheDir)).rejects.toThrow();
    }
  });

  it("off-switch off (matrix row 1a inputs): teardown cache write is a no-op and the host default overwrite still runs", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    const sandboxAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: NEWER, marker: "sandbox" });
    const hostAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" });

    const result = await runWithCache({
      sandboxAuth,
      hostAuth,
      env,
      sharedHomeAuthPath,
      cacheEnabledEnv: { ...env, PAPERCLIP_CODEX_AUTH_CACHE: "0" },
    });

    // Host overwrite still runs with the off-switch off.
    expect(result.outcome).toBe("copied");
    expect(result.finalHostAuth).toBe(sandboxAuth);
    // No cache slot is written.
    const cacheDir = resolveCodexAuthCacheDir(env, COMPANY_ID);
    await expect(readdir(cacheDir)).rejects.toThrow();
  });

  it("two concurrent teardown writes for the same identity leave one valid cache slot (no partial file)", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    await writeFile(
      sharedHomeAuthPath,
      subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" }),
      { mode: 0o600 },
    );
    const run = (marker: string) =>
      copyBackCodexAuth({
        readSandboxAuth: async () =>
          Buffer.from(subscriptionAuth({ accountId: "acct-x", lastRefresh: NEWER, marker }), "utf8"),
        hostAuthPath: sharedHomeAuthPath,
        log: () => {},
        resolveCacheEntryPath: (accountId) => ensureCodexAuthCacheEntryDir(env, accountId, COMPANY_ID),
        env,
      });
    await Promise.all([run("a"), run("b")]);

    const entryPath = resolveCodexAuthCacheEntryPath(env, "acct-x", COMPANY_ID);
    const slotDir = path.dirname(entryPath);
    // Exactly one valid slot file, no leftover staging temp.
    expect(await readdir(slotDir)).toEqual(["auth.json"]);
    const finalSlot = await readFile(entryPath, "utf8");
    expect(JSON.parse(finalSlot).tokens.account_id).toBe("acct-x");
  });

  it("the cache write never emits source token bytes or a raw account_id to the log", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    const sandboxAuth = subscriptionAuth({
      accountId: "SECRET-ACCT",
      lastRefresh: NEWER,
      marker: "TOKEN-SENTINEL",
    });
    const result = await runWithCache({ sandboxAuth, env, sharedHomeAuthPath });
    expect(await readCacheSlot(env, "SECRET-ACCT")).toBe(sandboxAuth);
    const combined = result.logs.join("\n");
    expect(combined).not.toContain("SENTINEL");
    expect(combined).not.toContain("SECRET-ACCT");
    expect(combined).not.toContain("id-token");
  });

  it("a read-only cache directory does not fail the copy-back: the successful host result is kept and no partial slot remains", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    const sandboxAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: NEWER, marker: "sandbox" });
    const hostAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" });
    await writeFile(sharedHomeAuthPath, hostAuth, { mode: 0o600 });

    // Pre-create the entry directory, then make it read-only so the cache-slot
    // temp create fails. The host overwrite runs first and must stay intact. The
    // additive cache write is best-effort, so its failure must not throw.
    const entryPath = await ensureCodexAuthCacheEntryDir(env, "acct-x", COMPANY_ID);
    const slotDir = path.dirname(entryPath);
    const logs: string[] = [];
    await chmod(slotDir, 0o500);
    let outcome: string;
    try {
      outcome = await copyBackCodexAuth({
        readSandboxAuth: async () => Buffer.from(sandboxAuth, "utf8"),
        hostAuthPath: sharedHomeAuthPath,
        log: (line) => {
          logs.push(line);
        },
        resolveCacheEntryPath: (accountId) => ensureCodexAuthCacheEntryDir(env, accountId, COMPANY_ID),
        env,
      });
    } finally {
      await chmod(slotDir, 0o700);
    }

    // The host copy-back succeeded and its result is returned unchanged.
    expect(outcome).toBe("copied");
    // Host default overwrite ran before the cache write and stays applied.
    expect(await readFile(sharedHomeAuthPath, "utf8")).toBe(sandboxAuth);
    // No partial slot file; only the (empty) slot directory remains.
    expect(await readdir(slotDir)).toEqual([]);
    // The failure is visible in the log with only the errno code. The raw
    // account_id (which the failing slot path embeds) never reaches the log.
    const combined = logs.join("\n");
    expect(combined).toContain("additive cache write failed (EACCES)");
    expect(combined).not.toContain("acct-x");
  });

  it("a rejecting cache-failure log does not override the successful host copy-back result", async () => {
    const { env, sharedHomeAuthPath } = await makeEnv();
    const sandboxAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: NEWER, marker: "sandbox" });
    const hostAuth = subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" });
    await writeFile(sharedHomeAuthPath, hostAuth, { mode: 0o600 });

    // Force the additive cache write to fail: pre-create the slot directory,
    // then make it read-only so the slot temp create fails with EACCES.
    const entryPath = await ensureCodexAuthCacheEntryDir(env, "acct-x", COMPANY_ID);
    const slotDir = path.dirname(entryPath);
    await chmod(slotDir, 0o500);

    // The logger rejects for the cache-failure diagnostic line only. The host
    // copy-back already installed the sandbox credential on disk, so this
    // rejection must not propagate and must not override the "copied" result.
    const logs: string[] = [];
    let outcome: Awaited<ReturnType<typeof copyBackCodexAuth>> | undefined;
    let thrown: unknown;
    try {
      outcome = await copyBackCodexAuth({
        readSandboxAuth: async () => Buffer.from(sandboxAuth, "utf8"),
        hostAuthPath: sharedHomeAuthPath,
        log: (line) => {
          logs.push(line);
          if (line.includes("additive cache write failed")) {
            return Promise.reject(new Error("log sink boom"));
          }
        },
        resolveCacheEntryPath: (accountId) => ensureCodexAuthCacheEntryDir(env, accountId, COMPANY_ID),
        env,
      }).catch((error: unknown) => {
        thrown = error;
        return undefined;
      });
    } finally {
      await chmod(slotDir, 0o700);
    }

    // The rejecting cache-failure log never surfaces as a thrown error.
    expect(thrown).toBeUndefined();
    // The host copy-back result is kept intact.
    expect(outcome).toBe("copied");
    expect(await readFile(sharedHomeAuthPath, "utf8")).toBe(sandboxAuth);
    // No partial slot file remains after the failed cache write.
    expect(await readdir(slotDir)).toEqual([]);
    // The cache-failure diagnostic was attempted even though the sink rejected.
    expect(logs.some((line) => line.includes("additive cache write failed (EACCES)"))).toBe(true);
  });
});
