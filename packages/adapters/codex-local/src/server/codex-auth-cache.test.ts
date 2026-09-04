import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertAccountHomeCacheDirStillValid,
  clearCodexAuthCache,
  clearCodexAuthCacheEntry,
  ensureCodexAuthCacheEntryDir,
  isCodexAuthCacheEnabled,
  resolveCodexAuthCacheDir,
  resolveCodexAuthCacheEntryPath,
  selectVendCredential,
  toCacheKey,
  withAccountHomeSecretMutationLock,
  withCodexAccountHomePromotionLock,
} from "./codex-auth-cache.js";
import { resolveSharedCodexHomeDir } from "./codex-home.js";

// This suite proves the per-identity host credential cache store. The cache is a
// separate directory outside the shared Codex home and outside the symlink
// allowlist. It keys one usable subscription credential per identity
// (`account_id`). The suite drives the real path resolver, the real directory
// guards, and the real decision predicate (`codex-auth-merge-decision.cjs`)
// against a real host tmp filesystem.
describe("codex auth cache store", () => {
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cache-"));
    cleanupDirs.push(dir);
    return dir;
  }

  function envFor(instanceHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PAPERCLIP_HOME: instanceHome,
      PAPERCLIP_INSTANCE_ID: "default",
      ...extra,
    };
  }

  function subscriptionAuth(input: { accountId: string; lastRefresh?: string; marker?: string }): string {
    const suffix = input.marker ?? input.accountId;
    return JSON.stringify({
      tokens: {
        id_token: `id-token-${suffix}`,
        access_token: `access-token-${suffix}`,
        refresh_token: `refresh-token-${suffix}`,
        account_id: input.accountId,
      },
      ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
    });
  }

  const NEWER = "2026-07-09T02:00:00Z";
  const OLDER = "2026-07-09T01:00:00Z";

  describe("Phase 1: cache store location and path scheme", () => {
    it("resolveCodexAuthCacheDir returns a path outside resolveSharedCodexHomeDir", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home, { CODEX_HOME: path.join(home, "shared-codex") });
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      const sharedHome = resolveSharedCodexHomeDir(env);
      expect(cacheDir.startsWith(sharedHome + path.sep)).toBe(false);
      expect(cacheDir).not.toBe(sharedHome);
    });

    it("resolveCodexAuthCacheDir returns a company-scoped path under the instance companies directory when companyId is set", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      expect(cacheDir).toBe(
        path.resolve(home, "instances", "default", "companies", "company-a", "codex-auth-cache"),
      );
    });

    it("resolveCodexAuthCacheEntryPath keys the entry by a sanitized account_id and ends with auth.json", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const entryPath = resolveCodexAuthCacheEntryPath(env, "acct-42", "company-a");
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      expect(entryPath).toBe(path.join(cacheDir, "acct-42", "auth.json"));
    });

    it("toCacheKey rejects an empty account_id, a path separator, and ..", () => {
      expect(() => toCacheKey("")).toThrow();
      expect(() => toCacheKey("   ")).toThrow();
      expect(() => toCacheKey("..")).toThrow();
      expect(() => toCacheKey(".")).toThrow();
      expect(() => toCacheKey("a/b")).toThrow();
      expect(() => toCacheKey("a\\b")).toThrow();
      expect(() => toCacheKey("../escape")).toThrow();
      expect(() => toCacheKey("a\0b")).toThrow();
      expect(toCacheKey("acct-42")).toBe("acct-42");
    });

    it("resolveCodexAuthCacheDir rejects a traversal companyId before it builds the path", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      // A traversal companyId must never make the cache root escape the
      // companies/ directory. Sanitization runs before path construction, so a
      // relative segment, a path separator, an absolute path, and a NUL byte all
      // fail loud.
      expect(() => resolveCodexAuthCacheDir(env, "")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, "   ")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, "..")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, ".")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, "../../etc")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, "/etc")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, "a/b")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, "a\\b")).toThrow();
      expect(() => resolveCodexAuthCacheDir(env, "a\0b")).toThrow();
      // The clear path inherits the same guard, so a traversal companyId can
      // never reach rm() on an escaped root.
      await expect(clearCodexAuthCache(env, "../../etc")).rejects.toThrow();
      const safeDir = resolveCodexAuthCacheDir(env, "company-a");
      expect(safeDir).toBe(
        path.resolve(home, "instances", "default", "companies", "company-a", "codex-auth-cache"),
      );
    });

    it("resolveCodexAuthCacheEntryPath rejects an identifier that toAccountHandle rejects", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      // A space, a plus sign, and a leading hyphen all fail the stricter
      // account-handle allowlist, even though the older denylist alone would
      // accept some of them.
      expect(() => resolveCodexAuthCacheEntryPath(env, "acct 42", "company-a")).toThrow();
      expect(() => resolveCodexAuthCacheEntryPath(env, "acct+42", "company-a")).toThrow();
      expect(() => resolveCodexAuthCacheEntryPath(env, "-rf", "company-a")).toThrow();
    });

    it("resolveCodexAuthCacheEntryPath verifies the resolved path stays under the cache root", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      // A traversal account_id is rejected by toCacheKey, so the resolved entry
      // path can never escape the cache root.
      expect(() => resolveCodexAuthCacheEntryPath(env, "../../etc", "company-a")).toThrow();
      const entryPath = resolveCodexAuthCacheEntryPath(env, "acct-ok", "company-a");
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      expect(entryPath.startsWith(cacheDir + path.sep)).toBe(true);
      expect(entryPath.endsWith(path.join("acct-ok", "auth.json"))).toBe(true);
    });

    it("ensureCodexAuthCacheEntryDir creates the cache root and the entry directory private (0700)", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const entryPath = await ensureCodexAuthCacheEntryDir(env, "acct-priv", "company-a");
      const entryDir = path.dirname(entryPath);
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      expect((await lstat(entryDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(cacheDir)).mode & 0o777).toBe(0o700);
    });

    it("the cache root fails closed (lstat) when it is a symlink or a non-directory", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      // Make the cache root a symlink to another directory. lstat (not stat)
      // must catch it and fail closed.
      await mkdir(path.dirname(cacheDir), { recursive: true });
      const target = path.join(home, "elsewhere");
      await mkdir(target, { recursive: true });
      await symlink(target, cacheDir);
      await expect(ensureCodexAuthCacheEntryDir(env, "acct-x", "company-a")).rejects.toThrow();
    });

    it("the entry directory fails closed (lstat) when it is a symlink or a non-directory", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      // Put a regular file where the entry directory must be.
      await writeFile(path.join(cacheDir, "acct-file"), "not a dir", { mode: 0o600 });
      await expect(ensureCodexAuthCacheEntryDir(env, "acct-file", "company-a")).rejects.toThrow();
    });
  });

  describe("Phase 4: identity-anchored vend", () => {
    async function stageHostAndCache(input: {
      hostAuth?: string;
      cacheAuthByAccount?: Record<string, string>;
    }): Promise<{ env: NodeJS.ProcessEnv; sharedHomeAuthPath: string }> {
      const home = await makeInstanceRoot();
      const env = envFor(home, { CODEX_HOME: path.join(home, "shared-codex") });
      const sharedHome = resolveSharedCodexHomeDir(env);
      await mkdir(sharedHome, { recursive: true });
      const sharedHomeAuthPath = path.join(sharedHome, "auth.json");
      if (input.hostAuth !== undefined) {
        await writeFile(sharedHomeAuthPath, input.hostAuth, { mode: 0o600 });
      }
      for (const [accountId, auth] of Object.entries(input.cacheAuthByAccount ?? {})) {
        const entryPath = await ensureCodexAuthCacheEntryDir(env, accountId, "company-a");
        await writeFile(entryPath, auth, { mode: 0o600 });
      }
      return { env, sharedHomeAuthPath };
    }

    const resolveEntry =
      (env: NodeJS.ProcessEnv) => (accountId: string) =>
        resolveCodexAuthCacheEntryPath(env, accountId, "company-a");

    it("vend refreshes the host identity when the cached copy is strictly newer for the same identity", async () => {
      const { env, sharedHomeAuthPath } = await stageHostAndCache({
        hostAuth: subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" }),
        cacheAuthByAccount: {
          "acct-x": subscriptionAuth({ accountId: "acct-x", lastRefresh: NEWER, marker: "cache" }),
        },
      });
      const outcome = await selectVendCredential(sharedHomeAuthPath, resolveEntry(env), () => undefined, env);
      expect(outcome).toBe("vended");
      const finalHost = await readFile(sharedHomeAuthPath, "utf8");
      expect(finalHost).toContain("acct-x");
      expect(finalHost).toContain("cache");
    });

    it("vend keeps the shared-home credential when the cache copy is older or a tie", async () => {
      for (const cacheRefresh of [OLDER, NEWER]) {
        const hostRefresh = cacheRefresh === OLDER ? NEWER : NEWER; // host newer or tie
        const { env, sharedHomeAuthPath } = await stageHostAndCache({
          hostAuth: subscriptionAuth({ accountId: "acct-x", lastRefresh: hostRefresh, marker: "host" }),
          cacheAuthByAccount: {
            "acct-x": subscriptionAuth({ accountId: "acct-x", lastRefresh: cacheRefresh, marker: "cache" }),
          },
        });
        const before = await readFile(sharedHomeAuthPath, "utf8");
        const outcome = await selectVendCredential(sharedHomeAuthPath, resolveEntry(env), () => undefined, env);
        expect(outcome).toBe("kept-host");
        expect(await readFile(sharedHomeAuthPath, "utf8")).toBe(before);
      }
    });

    it("vend never selects a cache slot with a different account_id than the host holds", async () => {
      const { env, sharedHomeAuthPath } = await stageHostAndCache({
        hostAuth: subscriptionAuth({ accountId: "acct-x", lastRefresh: OLDER, marker: "host" }),
        cacheAuthByAccount: {
          "acct-y": subscriptionAuth({ accountId: "acct-y", lastRefresh: NEWER, marker: "other" }),
        },
      });
      const before = await readFile(sharedHomeAuthPath, "utf8");
      const outcome = await selectVendCredential(sharedHomeAuthPath, resolveEntry(env), () => undefined, env);
      expect(outcome).toBe("kept-host");
      expect(await readFile(sharedHomeAuthPath, "utf8")).toBe(before);
    });

    it("vend does nothing when the host shared home has no auth.json (no random pick from the cache)", async () => {
      const { env, sharedHomeAuthPath } = await stageHostAndCache({
        cacheAuthByAccount: {
          "acct-y": subscriptionAuth({ accountId: "acct-y", lastRefresh: NEWER, marker: "other" }),
        },
      });
      const outcome = await selectVendCredential(sharedHomeAuthPath, resolveEntry(env), () => undefined, env);
      expect(outcome).toBe("no-host-identity");
      await expect(lstat(sharedHomeAuthPath)).rejects.toThrow();
    });

    it("vend does nothing when the host shared home holds an apikey (no subscription identity)", async () => {
      const { env, sharedHomeAuthPath } = await stageHostAndCache({
        hostAuth: JSON.stringify({ OPENAI_API_KEY: "sk-host" }),
        cacheAuthByAccount: {
          "acct-y": subscriptionAuth({ accountId: "acct-y", lastRefresh: NEWER, marker: "other" }),
        },
      });
      const before = await readFile(sharedHomeAuthPath, "utf8");
      const outcome = await selectVendCredential(sharedHomeAuthPath, resolveEntry(env), () => undefined, env);
      expect(outcome).toBe("no-host-identity");
      expect(await readFile(sharedHomeAuthPath, "utf8")).toBe(before);
    });

    it("the vend never emits token bytes or a raw account_id to the log", async () => {
      const { env, sharedHomeAuthPath } = await stageHostAndCache({
        hostAuth: subscriptionAuth({ accountId: "SECRET-ACCT", lastRefresh: OLDER, marker: "HOST-SENTINEL" }),
        cacheAuthByAccount: {
          "SECRET-ACCT": subscriptionAuth({ accountId: "SECRET-ACCT", lastRefresh: NEWER, marker: "CACHE-SENTINEL" }),
        },
      });
      const logs: string[] = [];
      await selectVendCredential(
        sharedHomeAuthPath,
        resolveEntry(env),
        (line) => {
          logs.push(line);
        },
        env,
      );
      const combined = logs.join("\n");
      expect(combined).not.toContain("SENTINEL");
      expect(combined).not.toContain("SECRET-ACCT");
      expect(combined).not.toContain("id-token");
    });
  });

  describe("Phase 5: cache-clear operator action and off-switch", () => {
    it("clearCodexAuthCacheEntry removes one identity slot and leaves other slots intact", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const keepPath = await ensureCodexAuthCacheEntryDir(env, "acct-keep", "company-a");
      const dropPath = await ensureCodexAuthCacheEntryDir(env, "acct-drop", "company-a");
      await writeFile(keepPath, subscriptionAuth({ accountId: "acct-keep" }), { mode: 0o600 });
      await writeFile(dropPath, subscriptionAuth({ accountId: "acct-drop" }), { mode: 0o600 });

      await clearCodexAuthCacheEntry(env, "acct-drop", "company-a");
      await expect(lstat(path.dirname(dropPath))).rejects.toThrow();
      expect(await readFile(keepPath, "utf8")).toContain("acct-keep");
    });

    it("clearCodexAuthCacheEntry rejects an account_id that escapes the cache root", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      await expect(clearCodexAuthCacheEntry(env, "../../etc", "company-a")).rejects.toThrow();
      await expect(clearCodexAuthCacheEntry(env, "a/b", "company-a")).rejects.toThrow();
    });

    it("clearCodexAuthCacheEntry is a benign no-op for a missing slot", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      await expect(clearCodexAuthCacheEntry(env, "acct-absent", "company-a")).resolves.toBeUndefined();
    });

    it("clearCodexAuthCache removes every slot", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      await ensureCodexAuthCacheEntryDir(env, "acct-1", "company-a");
      await ensureCodexAuthCacheEntryDir(env, "acct-2", "company-a");
      const cacheDir = resolveCodexAuthCacheDir(env, "company-a");
      expect((await readdir(cacheDir)).sort()).toEqual(["acct-1", "acct-2"]);
      await clearCodexAuthCache(env, "company-a");
      await expect(lstat(cacheDir)).rejects.toThrow();
    });

    it("isCodexAuthCacheEnabled defaults to on and turns off on an explicit falsy flag", () => {
      expect(isCodexAuthCacheEnabled({})).toBe(true);
      expect(isCodexAuthCacheEnabled({ PAPERCLIP_CODEX_AUTH_CACHE: "1" })).toBe(true);
      expect(isCodexAuthCacheEnabled({ PAPERCLIP_CODEX_AUTH_CACHE: "on" })).toBe(true);
      expect(isCodexAuthCacheEnabled({ PAPERCLIP_CODEX_AUTH_CACHE: "0" })).toBe(false);
      expect(isCodexAuthCacheEnabled({ PAPERCLIP_CODEX_AUTH_CACHE: "false" })).toBe(false);
      expect(isCodexAuthCacheEnabled({ PAPERCLIP_CODEX_AUTH_CACHE: "off" })).toBe(false);
      expect(isCodexAuthCacheEnabled({ PAPERCLIP_CODEX_AUTH_CACHE: "no" })).toBe(false);
    });
  });

  describe("Phase 6: whole-promotion serialization for one company", () => {
    it("withCodexAccountHomePromotionLock never overlaps two concurrent callers for the same company", async () => {
      // The device-login route holds this lock across its whole promotion
      // sequence: the account-home directory decision, the credential write,
      // and the secret bind or cleanup that follows. Two different logins for
      // the SAME Codex account must run that whole sequence one at a time, so
      // a login can never delete the shared account-home directory while
      // another login's own sequence is still writing its credential or
      // binding its own secret to that same directory. This proves the lock
      // itself enforces that: two concurrent callers for one company never run
      // their callbacks at the same time, whichever caller goes first.
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const events: string[] = [];
      let releaseFirstCaller!: () => void;
      const firstCallerGate = new Promise<void>((resolve) => {
        releaseFirstCaller = resolve;
      });

      const firstCall = withCodexAccountHomePromotionLock(env, "company-shared", async () => {
        events.push("first-enter");
        await firstCallerGate;
        events.push("first-exit");
        return "first";
      });
      // Give the first caller a chance to acquire the lock and enter its
      // callback before the second caller starts racing for the same lock.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondCall = withCodexAccountHomePromotionLock(env, "company-shared", async () => {
        events.push("second-enter");
        events.push("second-exit");
        return "second";
      });
      // The second caller must stay blocked on the lock while the first
      // caller still holds it: it must never log `second-enter` before the
      // first caller's `first-exit`.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["first-enter"]);

      releaseFirstCaller();
      const [first, second] = await Promise.all([firstCall, secondCall]);
      expect(first).toBe("first");
      expect(second).toBe("second");
      expect(events).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
    });

    it("withCodexAccountHomePromotionLock keeps two different companies independent", async () => {
      // The lock is per company, so two different companies' device logins
      // never wait on each other.
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const events: string[] = [];
      let releaseCompanyA!: () => void;
      const companyAGate = new Promise<void>((resolve) => {
        releaseCompanyA = resolve;
      });

      const companyACall = withCodexAccountHomePromotionLock(env, "company-a", async () => {
        events.push("a-enter");
        await companyAGate;
        events.push("a-exit");
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const companyBCall = withCodexAccountHomePromotionLock(env, "company-b", async () => {
        events.push("b-enter");
        events.push("b-exit");
      });
      await companyBCall;
      // Company B's callback ran and finished while company A's callback was
      // still waiting on its own gate, so the two locks never contended.
      expect(events).toEqual(["a-enter", "b-enter", "b-exit"]);

      releaseCompanyA();
      await companyACall;
      expect(events).toEqual(["a-enter", "b-enter", "b-exit", "a-exit"]);
    });
  });

  describe("Phase 7: account-home secret-mutation serialization for one company", () => {
    it("withAccountHomeSecretMutationLock never overlaps two concurrent callers for the same company", async () => {
      // The secrets service holds this lock for the whole of a `local_encrypted`
      // secret's create or rotate call, and an account-home cleanup's claimant
      // scan holds it for the whole of its final check-and-delete step. This
      // proves the lock itself enforces mutual exclusion between any two
      // holders for one company, whichever caller goes first.
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const events: string[] = [];
      let releaseFirstCaller!: () => void;
      const firstCallerGate = new Promise<void>((resolve) => {
        releaseFirstCaller = resolve;
      });

      const firstCall = withAccountHomeSecretMutationLock(env, "company-shared", async () => {
        events.push("first-enter");
        await firstCallerGate;
        events.push("first-exit");
        return "first";
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondCall = withAccountHomeSecretMutationLock(env, "company-shared", async () => {
        events.push("second-enter");
        events.push("second-exit");
        return "second";
      });
      // The second caller must stay blocked on the lock while the first
      // caller still holds it: it must never log `second-enter` before the
      // first caller's `first-exit`.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["first-enter"]);

      releaseFirstCaller();
      const [first, second] = await Promise.all([firstCall, secondCall]);
      expect(first).toBe("first");
      expect(second).toBe("second");
      expect(events).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
    });

    it("withAccountHomeSecretMutationLock keeps two different companies independent", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const events: string[] = [];
      let releaseCompanyA!: () => void;
      const companyAGate = new Promise<void>((resolve) => {
        releaseCompanyA = resolve;
      });

      const companyACall = withAccountHomeSecretMutationLock(env, "company-a", async () => {
        events.push("a-enter");
        await companyAGate;
        events.push("a-exit");
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const companyBCall = withAccountHomeSecretMutationLock(env, "company-b", async () => {
        events.push("b-enter");
        events.push("b-exit");
      });
      await companyBCall;
      expect(events).toEqual(["a-enter", "b-enter", "b-exit"]);

      releaseCompanyA();
      await companyACall;
      expect(events).toEqual(["a-enter", "b-enter", "b-exit", "a-exit"]);
    });

    it("withAccountHomeSecretMutationLock does not contend with withCodexAccountHomePromotionLock for the same company", async () => {
      // The two locks use separate lock directories (Security condition: no
      // shared lock key), so a device-login promotion that holds
      // `withCodexAccountHomePromotionLock` for its whole sequence can still
      // call into a secrets-service write that takes this lock without
      // deadlocking on itself.
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const events: string[] = [];

      await withCodexAccountHomePromotionLock(env, "company-shared", async () => {
        events.push("promotion-enter");
        await withAccountHomeSecretMutationLock(env, "company-shared", async () => {
          events.push("mutation-enter");
          events.push("mutation-exit");
        });
        events.push("promotion-exit");
      });

      expect(events).toEqual(["promotion-enter", "mutation-enter", "mutation-exit", "promotion-exit"]);
    });
  });

  describe("Phase 8: account-home directory validity before a secret write commits", () => {
    it("resolves for a value naming a directory that still exists under the cache root", async () => {
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const companyId = "company-still-exists";
      const entryPath = await ensureCodexAuthCacheEntryDir(env, "acct-still-exists", companyId);
      const accountHomeDir = path.dirname(entryPath);

      await expect(
        assertAccountHomeCacheDirStillValid(env, companyId, accountHomeDir),
      ).resolves.toBeUndefined();
    });

    it("rejects a value naming a directory under the cache root that no longer exists", async () => {
      // This is the shape an account-home cleanup leaves behind: a value that
      // once named a real directory, now removed. A create or a rotate that
      // is about to commit this exact value must fail instead of writing a
      // secret that points at nothing.
      const home = await makeInstanceRoot();
      const env = envFor(home);
      const companyId = "company-removed";
      const entryPath = await ensureCodexAuthCacheEntryDir(env, "acct-removed", companyId);
      const accountHomeDir = path.dirname(entryPath);
      await rm(accountHomeDir, { recursive: true, force: true });

      await expect(assertAccountHomeCacheDirStillValid(env, companyId, accountHomeDir)).rejects.toThrow(
        /no longer exists/,
      );
    });

    it("leaves a value alone when it does not sit under this company's cache root", async () => {
      // Most `local_encrypted` secret values (an API key, a token, a
      // hand-typed string) never sit under the cache root, so this check must
      // never reject a write that only happens to name a missing path.
      const home = await makeInstanceRoot();
      const env = envFor(home);

      await expect(
        assertAccountHomeCacheDirStillValid(env, "company-unrelated", "/some/unrelated/missing/path"),
      ).resolves.toBeUndefined();
    });
  });
});
