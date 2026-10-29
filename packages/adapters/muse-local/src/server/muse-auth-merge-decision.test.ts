import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

const decisionScriptPath = fileURLToPath(
  new URL("./muse-auth-merge-decision.cjs", import.meta.url),
);

const decisionModule = createRequire(import.meta.url)(decisionScriptPath) as {
  decide: (
    source: { kind: "usable" | "unusable"; identity?: string | null; freshnessRaw?: unknown; isExpiry?: boolean },
    destination: { kind: "usable" | "unusable"; identity?: string | null; freshnessRaw?: unknown; isExpiry?: boolean },
    nowMs: number,
  ) => number;
  parseAuthFile: (filePath: string) => { kind: "usable" | "unusable"; identity?: string | null; freshnessRaw?: unknown; isExpiry?: boolean };
  USE_SOURCE: number;
  KEEP_DESTINATION: number;
  UNREADABLE_EXPIRY: number;
  IMPLAUSIBLE_EXPIRY: number;
};

const { decide, parseAuthFile, USE_SOURCE, KEEP_DESTINATION, UNREADABLE_EXPIRY, IMPLAUSIBLE_EXPIRY } =
  decisionModule;

const IDENTITY_A = "muse-account-1111";
const IDENTITY_B = "muse-account-2222";

describe("muse-auth-merge-decision predicate", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-muse-merge-"));
    cleanupDirs.push(dir);
    return dir;
  }

  function authJson(input: {
    accountId?: string | null;
    token?: string;
    expiresAt?: string;
    lastRefresh?: string;
  }): string {
    const obj: Record<string, unknown> = {};
    if (input.accountId !== undefined) {
      if (input.accountId !== null) obj.account_id = input.accountId;
    } else {
      obj.account_id = IDENTITY_A;
    }
    if (input.token !== undefined) obj.token = input.token;
    else obj.token = "default-token";
    if (input.expiresAt !== undefined) obj.expires_at = input.expiresAt;
    if (input.lastRefresh !== undefined) obj.last_refresh = input.lastRefresh;
    return JSON.stringify(obj, null, 2);
  }

  async function runSubprocess(sourceContent: string, destContent: string): Promise<number> {
    const dir = await makeTempDir();
    const sourcePath = path.join(dir, "source.json");
    const destPath = path.join(dir, "destination.json");
    await writeFile(sourcePath, sourceContent, { mode: 0o600 });
    await writeFile(destPath, destContent, { mode: 0o600 });

    try {
      await execFile("node", [decisionScriptPath, sourcePath, destPath]);
      return 0;
    } catch (error: any) {
      if (typeof error?.code === "number") return error.code;
      throw error;
    }
  }

  const now = Date.now();
  const FUTURE_1 = new Date(now + 60_000).toISOString();
  const FUTURE_2 = new Date(now + 120_000).toISOString();

  it("returns USE_SOURCE (10) when source has matching identity and strictly newer expiry", async () => {
    const source = authJson({ accountId: IDENTITY_A, token: "new-token", expiresAt: FUTURE_2 });
    const dest = authJson({ accountId: IDENTITY_A, token: "old-token", expiresAt: FUTURE_1 });
    const exitCode = await runSubprocess(source, dest);
    expect(exitCode).toBe(USE_SOURCE);
  });

  it("returns KEEP_DESTINATION (20) when source has no identity", async () => {
    const source = authJson({ accountId: null, token: "new-token", expiresAt: FUTURE_2 });
    const dest = authJson({ accountId: IDENTITY_A, token: "old-token", expiresAt: FUTURE_1 });
    const exitCode = await runSubprocess(source, dest);
    expect(exitCode).toBe(KEEP_DESTINATION);
  });

  it("returns KEEP_DESTINATION (20) when destination has no identity", async () => {
    const source = authJson({ accountId: IDENTITY_A, token: "new-token", expiresAt: FUTURE_2 });
    const dest = authJson({ accountId: null, token: "old-token", expiresAt: FUTURE_1 });
    const exitCode = await runSubprocess(source, dest);
    expect(exitCode).toBe(KEEP_DESTINATION);
  });

  it("returns KEEP_DESTINATION (20) when source has a conflicting identity", async () => {
    const source = authJson({ accountId: IDENTITY_B, token: "new-token", expiresAt: FUTURE_2 });
    const dest = authJson({ accountId: IDENTITY_A, token: "old-token", expiresAt: FUTURE_1 });
    const exitCode = await runSubprocess(source, dest);
    expect(exitCode).toBe(KEEP_DESTINATION);
  });

  it("returns KEEP_DESTINATION (20) when source copies destination identity but is older or tied", async () => {
    // Tied expiry
    const tiedSource = authJson({ accountId: IDENTITY_A, token: "tied-token", expiresAt: FUTURE_1 });
    const dest = authJson({ accountId: IDENTITY_A, token: "old-token", expiresAt: FUTURE_1 });
    expect(await runSubprocess(tiedSource, dest)).toBe(KEEP_DESTINATION);

    // Older expiry
    const olderSource = authJson({ accountId: IDENTITY_A, token: "older-token", expiresAt: new Date(now - 10_000).toISOString() });
    expect(await runSubprocess(olderSource, dest)).toBe(KEEP_DESTINATION);
  });

  it("returns IMPLAUSIBLE_EXPIRY (22) when source timestamp is implausibly far ahead", async () => {
    const farFuture = new Date(now + 500 * 24 * 60 * 60 * 1000).toISOString();
    const source = authJson({ accountId: IDENTITY_A, token: "poisoned-token", expiresAt: farFuture });
    const dest = authJson({ accountId: IDENTITY_A, token: "old-token", expiresAt: FUTURE_1 });
    expect(await runSubprocess(source, dest)).toBe(IMPLAUSIBLE_EXPIRY);
  });

  it("returns UNREADABLE_EXPIRY (21) when expiry is present but not a valid ISO date", async () => {
    const source = JSON.stringify({ account_id: IDENTITY_A, token: "tok", expires_at: "not-a-date" });
    const dest = authJson({ accountId: IDENTITY_A, token: "old-token", expiresAt: FUTURE_1 });
    expect(await runSubprocess(source, dest)).toBe(UNREADABLE_EXPIRY);
  });
});
