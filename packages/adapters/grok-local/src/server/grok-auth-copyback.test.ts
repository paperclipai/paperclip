import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyBackGrokAuth } from "./grok-auth-copyback.js";

// The copy-out module reuses the direction-agnostic decision predicate
// (`grok-auth-merge-decision.cjs`): the sandbox copy is always the `source`
// and the host copy is always the `destination`, so exit 10 (use source)
// installs the sandbox credential onto the host and every other exit keeps
// the host credential untouched. This suite drives the REAL `.cjs` through
// the module (no stub predicate) against a real host tmp filesystem,
// injecting only the sandbox read.
describe("copyBackGrokAuth", () => {
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

  const IDENTITY = "https://auth.x.ai::11111111-1111-1111-1111-111111111111";
  const OTHER_IDENTITY = "https://auth.x.ai::22222222-2222-2222-2222-222222222222";

  function auth(input: { identityKey?: string; expiresAt?: string; marker: string }): string {
    return JSON.stringify(
      {
        [input.identityKey ?? IDENTITY]: {
          key: `key-${input.marker}`,
          refresh_token: `refresh-${input.marker}`,
          ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
        },
      },
      null,
      2,
    );
  }

  async function makeHostDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-grok-copyback-"));
    cleanupDirs.push(dir);
    return dir;
  }

  const now = Date.now();
  const NEWER = new Date(now + 2 * 60_000).toISOString();
  const OLDER = new Date(now + 60_000).toISOString();

  async function runCopyBack(input: {
    sandboxAuth: string | (() => Promise<Buffer>);
    hostAuth?: string;
    hostHomeDir?: string;
  }): Promise<{
    outcome: Awaited<ReturnType<typeof copyBackGrokAuth>>;
    finalHostAuth: string | null;
    finalHostMode: number | null;
    logs: string[];
    leftoverEntries: string[];
  }> {
    const hostHomeDir = input.hostHomeDir ?? (await makeHostDir());
    const hostAuthPath = path.join(hostHomeDir, "auth.json");
    if (input.hostAuth !== undefined) {
      await writeFile(hostAuthPath, input.hostAuth, { mode: 0o600 });
    }

    const readSandboxAuth =
      typeof input.sandboxAuth === "function"
        ? input.sandboxAuth
        : async () => Buffer.from(input.sandboxAuth as string, "utf8");

    const logs: string[] = [];
    const outcome = await copyBackGrokAuth({
      readSandboxAuth,
      hostHomeDir,
      log: (line) => {
        logs.push(line);
      },
    });

    const finalHostAuth = await readFile(hostAuthPath, "utf8").catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    );
    const finalHostMode = finalHostAuth === null ? null : (await lstat(hostAuthPath)).mode & 0o777;
    const leftoverEntries = (await readdir(hostHomeDir)).filter((name) => name !== "auth.json");
    return { outcome, finalHostAuth, finalHostMode, logs, leftoverEntries };
  }

  it("installs a strictly-later same-identity credential at mode 0600", async () => {
    const sandboxAuth = auth({ expiresAt: NEWER, marker: "sandbox-newer-SENTINEL" });
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-older-SENTINEL" });

    const result = await runCopyBack({ sandboxAuth, hostAuth });

    expect(result.outcome).toBe("copied");
    expect(result.finalHostAuth).toBe(sandboxAuth);
    expect(result.finalHostMode).toBe(0o600);
    // Temp staging file must be gone once the swap completes.
    expect(result.leftoverEntries).toEqual([]);
    // Never leak token bytes in log output.
    expect(result.logs.join("\n")).not.toContain("SENTINEL");
  });

  it("keeps the host credential when the predicate keeps the destination", async () => {
    const hostKeep = auth({ expiresAt: OLDER, marker: "host-keep" });
    const cases: { name: string; sandboxAuth: string; hostAuth: string }[] = [
      {
        name: "tie",
        sandboxAuth: auth({ expiresAt: NEWER, marker: "sandbox-tie" }),
        hostAuth: auth({ expiresAt: NEWER, marker: "host-tie" }),
      },
      {
        name: "sandbox older",
        sandboxAuth: auth({ expiresAt: OLDER, marker: "sandbox-older" }),
        hostAuth: auth({ expiresAt: NEWER, marker: "host-newer" }),
      },
      {
        name: "identity mismatch",
        sandboxAuth: auth({ identityKey: OTHER_IDENTITY, expiresAt: NEWER, marker: "sandbox-other" }),
        hostAuth: hostKeep,
      },
      {
        name: "sandbox unusable JSON",
        sandboxAuth: "{not valid json",
        hostAuth: hostKeep,
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

  it("creates no host credential when the destination auth.json does not exist, through stage, predicate, and install steps", async () => {
    const hostHomeDir = await makeHostDir();
    const sandboxAuth = auth({ expiresAt: NEWER, marker: "sandbox-no-dest" });

    const result = await runCopyBack({ sandboxAuth, hostHomeDir });

    expect(result.outcome).toBe("kept-host");
    expect(result.finalHostAuth).toBeNull();
    expect(result.leftoverEntries).toEqual([]);
  });

  it("returns kept-host and writes nothing when the sandbox auth.json is absent", async () => {
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-intact" });
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
    // No staging temp is ever created on the ENOENT path.
    expect(result.leftoverEntries).toEqual([]);
    expect(result.logs.join("\n")).toContain("no sandbox credential to copy back");
  });

  it("rethrows a sandbox read error that is not ENOENT", async () => {
    const hostHomeDir = await makeHostDir();
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-intact" });
    const hostAuthPath = path.join(hostHomeDir, "auth.json");
    await writeFile(hostAuthPath, hostAuth, { mode: 0o600 });

    await expect(
      copyBackGrokAuth({
        readSandboxAuth: async () => {
          throw new Error("sandbox read boom");
        },
        hostHomeDir,
        log: () => {},
      }),
    ).rejects.toThrow(/sandbox read boom/);

    expect(await readFile(hostAuthPath, "utf8")).toBe(hostAuth);
    expect((await readdir(hostHomeDir)).filter((name) => name !== "auth.json")).toEqual([]);
  });

  it("serializes two concurrent copy-out operations on one home", async () => {
    const hostHomeDir = await makeHostDir();
    const hostAuthPath = path.join(hostHomeDir, "auth.json");
    await writeFile(hostAuthPath, auth({ expiresAt: OLDER, marker: "host" }), { mode: 0o600 });

    const run = (marker: string, expiresAt: string) =>
      copyBackGrokAuth({
        readSandboxAuth: async () => Buffer.from(auth({ expiresAt, marker }), "utf8"),
        hostHomeDir,
        log: () => {},
      });

    await Promise.all([
      run("a", new Date(now + 3 * 60_000).toISOString()),
      run("b", new Date(now + 4 * 60_000).toISOString()),
    ]);

    // Exactly one valid file, no leftover staging temp, regardless of which
    // concurrent write won the lock first.
    expect(await readdir(hostHomeDir)).toEqual(["auth.json"]);
    const finalAuth = JSON.parse(await readFile(hostAuthPath, "utf8"));
    expect(Object.keys(finalAuth)).toEqual([IDENTITY]);
  });

  it("leaves no temporary file after a successful install", async () => {
    const result = await runCopyBack({
      sandboxAuth: auth({ expiresAt: NEWER, marker: "sandbox" }),
      hostAuth: auth({ expiresAt: OLDER, marker: "host" }),
    });
    expect(result.outcome).toBe("copied");
    expect(result.leftoverEntries).toEqual([]);
  });

  it("leaves no temporary file when the predicate keeps the destination", async () => {
    const result = await runCopyBack({
      sandboxAuth: auth({ expiresAt: OLDER, marker: "sandbox" }),
      hostAuth: auth({ expiresAt: NEWER, marker: "host" }),
    });
    expect(result.outcome).toBe("kept-host");
    expect(result.leftoverEntries).toEqual([]);
  });

  it("leaves no temporary file after an install error", async () => {
    const hostHomeDir = await makeHostDir();
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-intact" });
    const hostAuthPath = path.join(hostHomeDir, "auth.json");
    await writeFile(hostAuthPath, hostAuth, { mode: 0o600 });
    const before = await stat(hostAuthPath);

    await chmod(hostHomeDir, 0o500); // r-x: readable/traversable, not writable
    try {
      const sandboxAuth = auth({ expiresAt: NEWER, marker: "sandbox-newer" });
      await expect(
        copyBackGrokAuth({
          readSandboxAuth: async () => Buffer.from(sandboxAuth, "utf8"),
          hostHomeDir,
          log: () => {},
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(hostHomeDir, 0o700);
    }

    const after = await stat(hostAuthPath);
    expect(await readFile(hostAuthPath, "utf8")).toBe(hostAuth);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await readdir(hostHomeDir)).filter((name) => name !== "auth.json")).toEqual([]);
  });

  it("keeps no backup copy of the displaced credential in the destination directory", async () => {
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-displaced" });
    const sandboxAuth = auth({ expiresAt: NEWER, marker: "sandbox-newer" });

    const result = await runCopyBack({ sandboxAuth, hostAuth });

    expect(result.outcome).toBe("copied");
    // The staged temp is the only extra file the copy-out may ever create,
    // and it is always removed. No backup of the displaced `host-displaced`
    // credential survives anywhere in the destination directory.
    expect(result.leftoverEntries).toEqual([]);
  });

  it("logs no token bytes and no home path on an error", async () => {
    const marker = "SECRET-ACCOUNT-HANDLE";
    const root = await mkdtemp(path.join(os.tmpdir(), `paperclip-grok-copyback-${marker}-`));
    cleanupDirs.push(root);
    const hostAuth = auth({ expiresAt: OLDER, marker: "HOST-TOKEN-SENTINEL" });
    await writeFile(path.join(root, "auth.json"), hostAuth, { mode: 0o600 });

    await chmod(root, 0o500);
    const logs: string[] = [];
    try {
      await copyBackGrokAuth({
        readSandboxAuth: async () => Buffer.from(auth({ expiresAt: NEWER, marker: "SANDBOX-TOKEN-SENTINEL" }), "utf8"),
        hostHomeDir: root,
        log: (line) => {
          logs.push(line);
        },
      }).catch(() => undefined);
    } finally {
      await chmod(root, 0o700);
    }

    const combined = logs.join("\n");
    expect(combined).toContain("EACCES");
    expect(combined).toContain("failed");
    expect(combined).not.toContain(marker);
    expect(combined).not.toContain("SENTINEL");
  });
});
