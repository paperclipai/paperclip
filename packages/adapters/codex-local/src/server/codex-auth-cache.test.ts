import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearCodexAuthCache,
  clearCodexAuthCacheEntry,
  ensureCodexAuthCacheEntryDir,
  isCodexAuthCacheEnabled,
  resolveCodexAuthCacheDir,
  resolveCodexAuthCacheEntryPath,
  selectVendCredential,
  toCacheKey,
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
});
