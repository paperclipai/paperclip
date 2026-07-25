import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyBackCodexAuth } from "./codex-auth-copyback.js";

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
