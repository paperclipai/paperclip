import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

const decisionScriptPath = fileURLToPath(new URL("./grok-auth-merge-decision.cjs", import.meta.url));

// The exact-boundary cases below drive the predicate's pure `decide` function
// directly (via `require`, never spawning a process), so the 400-day
// plausibility bound can be tested to the exact millisecond without racing
// subprocess-spawn wall-clock drift. Every other case drives the REAL `.cjs`
// through a spawned `node` process (no stub), matching how the copy-out
// module invokes it in production.
const decisionModule = createRequire(import.meta.url)(decisionScriptPath) as {
  decide: (
    source: { kind: "usable" | "unusable"; identityKey?: string; expiresAtRaw?: unknown },
    destination: { kind: "usable" | "unusable"; identityKey?: string; expiresAtRaw?: unknown },
    nowMs: number,
  ) => number;
  USE_SOURCE: number;
  KEEP_DESTINATION: number;
  UNREADABLE_EXPIRY: number;
  IMPLAUSIBLE_EXPIRY: number;
  MAX_PLAUSIBLE_EXPIRY_MS: number;
};
const { decide, USE_SOURCE, KEEP_DESTINATION, UNREADABLE_EXPIRY, IMPLAUSIBLE_EXPIRY, MAX_PLAUSIBLE_EXPIRY_MS } =
  decisionModule;

const IDENTITY_A = "https://auth.x.ai::11111111-1111-1111-1111-111111111111";
const IDENTITY_B = "https://auth.x.ai::22222222-2222-2222-2222-222222222222";

describe("grok-auth-merge-decision predicate", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function usableAuthJson(input: { identityKey?: string; expiresAt?: unknown; marker: string }): string {
    const value: Record<string, unknown> = {
      key: `key-${input.marker}`,
      refresh_token: `refresh-${input.marker}`,
    };
    if (input.expiresAt !== undefined) value.expires_at = input.expiresAt;
    return JSON.stringify({ [input.identityKey ?? IDENTITY_A]: value });
  }

  const ABSENT = Symbol("absent");

  async function runDecision(input: {
    sourceAuth: string | typeof ABSENT;
    destinationAuth: string | typeof ABSENT;
  }): Promise<number> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-grok-merge-decision-"));
    cleanupDirs.push(dir);
    const sourcePath = path.join(dir, "source-auth.json");
    const destinationPath = path.join(dir, "destination-auth.json");
    if (input.sourceAuth !== ABSENT) await writeFile(sourcePath, input.sourceAuth, { mode: 0o600 });
    if (input.destinationAuth !== ABSENT) await writeFile(destinationPath, input.destinationAuth, { mode: 0o600 });
    try {
      await execFile("node", [decisionScriptPath, sourcePath, destinationPath]);
      return 0;
    } catch (error) {
      const failure = error as { code?: unknown };
      if (typeof failure.code === "number") return failure.code;
      throw error;
    }
  }

  it("uses the source when the identity matches and the source expiry is later", async () => {
    const now = Date.now();
    const sourceAuth = usableAuthJson({ marker: "src", expiresAt: new Date(now + 2 * 60_000).toISOString() });
    const destinationAuth = usableAuthJson({ marker: "dst", expiresAt: new Date(now + 60_000).toISOString() });
    expect(await runDecision({ sourceAuth, destinationAuth })).toBe(USE_SOURCE);
  });

  it("keeps the destination when the identity key differs", async () => {
    const now = Date.now();
    const sourceAuth = usableAuthJson({
      identityKey: IDENTITY_A,
      marker: "src",
      expiresAt: new Date(now + 2 * 60_000).toISOString(),
    });
    const destinationAuth = usableAuthJson({
      identityKey: IDENTITY_B,
      marker: "dst",
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    expect(await runDecision({ sourceAuth, destinationAuth })).toBe(KEEP_DESTINATION);
  });

  it("keeps the destination when the source expiry equals the destination expiry", async () => {
    const sameExpiry = new Date(Date.now() + 60_000).toISOString();
    const sourceAuth = usableAuthJson({ marker: "src", expiresAt: sameExpiry });
    const destinationAuth = usableAuthJson({ marker: "dst", expiresAt: sameExpiry });
    expect(await runDecision({ sourceAuth, destinationAuth })).toBe(KEEP_DESTINATION);
  });

  it("keeps the destination when either side is unusable", async () => {
    const now = Date.now();
    const usable = usableAuthJson({ marker: "ok", expiresAt: new Date(now + 60_000).toISOString() });
    const cases: { name: string; sourceAuth: string | typeof ABSENT; destinationAuth: string | typeof ABSENT }[] = [
      { name: "source malformed JSON", sourceAuth: "{not valid json", destinationAuth: usable },
      {
        name: "source missing refresh_token",
        sourceAuth: JSON.stringify({ [IDENTITY_A]: { key: "k" } }),
        destinationAuth: usable,
      },
      { name: "destination absent", sourceAuth: usable, destinationAuth: ABSENT },
      { name: "destination malformed JSON", sourceAuth: usable, destinationAuth: "{not valid json" },
    ];
    for (const entry of cases) {
      const code = await runDecision({ sourceAuth: entry.sourceAuth, destinationAuth: entry.destinationAuth });
      expect(code, entry.name).toBe(KEEP_DESTINATION);
    }
  });

  it("keeps the destination when the payload holds more than one top-level key", async () => {
    const now = Date.now();
    const destinationAuth = usableAuthJson({ marker: "dst", expiresAt: new Date(now + 60_000).toISOString() });
    const multiKeySource = JSON.stringify({
      [IDENTITY_A]: { key: "k", refresh_token: "r", expires_at: new Date(now + 120_000).toISOString() },
      extra: { key: "k2", refresh_token: "r2" },
    });
    expect(await runDecision({ sourceAuth: multiKeySource, destinationAuth })).toBe(KEEP_DESTINATION);
  });

  it("reads an ISO-8601 expiry, an epoch-seconds expiry, and an epoch-milliseconds expiry", async () => {
    const now = Date.now();
    const encodings: { name: string; source: unknown; destination: unknown }[] = [
      {
        name: "ISO-8601",
        source: new Date(now + 2 * 60_000).toISOString(),
        destination: new Date(now + 60_000).toISOString(),
      },
      {
        name: "epoch seconds",
        source: Math.round((now + 2 * 60_000) / 1000),
        destination: Math.round((now + 60_000) / 1000),
      },
      { name: "epoch milliseconds", source: now + 2 * 60_000, destination: now + 60_000 },
    ];
    for (const entry of encodings) {
      const sourceAuth = usableAuthJson({ marker: "src", expiresAt: entry.source });
      const destinationAuth = usableAuthJson({ marker: "dst", expiresAt: entry.destination });
      const code = await runDecision({ sourceAuth, destinationAuth });
      expect(code, entry.name).toBe(USE_SOURCE);
    }
  });

  it("exits 21 and keeps the destination for an unreadable expiry shape", async () => {
    const now = Date.now();
    const destinationAuth = usableAuthJson({ marker: "dst", expiresAt: new Date(now + 60_000).toISOString() });
    const badShapes: unknown[] = [true, "not-a-date", "2026/01/01 00:00:00", {}, []];
    for (const badExpiry of badShapes) {
      const sourceAuth = usableAuthJson({ marker: "src", expiresAt: badExpiry });
      const code = await runDecision({ sourceAuth, destinationAuth });
      expect(code, JSON.stringify(badExpiry)).toBe(UNREADABLE_EXPIRY);
    }
  });

  it("uses the source for a source expiry exactly at the 400-day bound", () => {
    const nowMs = Date.now();
    const source = { kind: "usable" as const, identityKey: IDENTITY_A, expiresAtRaw: nowMs + MAX_PLAUSIBLE_EXPIRY_MS };
    const destination = { kind: "usable" as const, identityKey: IDENTITY_A, expiresAtRaw: nowMs };
    expect(decide(source, destination, nowMs)).toBe(USE_SOURCE);
  });

  it("exits 22 and keeps the destination for a source expiry one millisecond beyond the 400-day bound", () => {
    const nowMs = Date.now();
    const source = {
      kind: "usable" as const,
      identityKey: IDENTITY_A,
      expiresAtRaw: nowMs + MAX_PLAUSIBLE_EXPIRY_MS + 1,
    };
    const destination = { kind: "usable" as const, identityKey: IDENTITY_A, expiresAtRaw: nowMs };
    expect(decide(source, destination, nowMs)).toBe(IMPLAUSIBLE_EXPIRY);
  });

  it("measures the 400-day bound against the host clock and not against a sandbox-supplied time", () => {
    // Fixed, unambiguous epoch-millisecond instants (both well above the
    // epoch-seconds/epoch-milliseconds threshold). Neither parsed side
    // changes between the two assertions below — only the caller-supplied
    // `nowMs` moves — so a passing/failing bound can only be explained by the
    // caller's clock, never by a value embedded in either payload.
    const sourceExpiryMs = 2_000_000_000_000;
    const destinationExpiryMs = 1_000_000_000_000;
    const source = { kind: "usable" as const, identityKey: IDENTITY_A, expiresAtRaw: sourceExpiryMs };
    const destination = { kind: "usable" as const, identityKey: IDENTITY_A, expiresAtRaw: destinationExpiryMs };

    expect(decide(source, destination, sourceExpiryMs - MAX_PLAUSIBLE_EXPIRY_MS)).toBe(USE_SOURCE);
    expect(decide(source, destination, sourceExpiryMs - MAX_PLAUSIBLE_EXPIRY_MS - 1)).toBe(IMPLAUSIBLE_EXPIRY);
  });

  it("keeps the destination for a forged source that copies the destination identity and a far-future expiry", async () => {
    const now = Date.now();
    const destinationAuth = usableAuthJson({ marker: "dst", expiresAt: new Date(now + 60_000).toISOString() });
    // 500 days ahead is comfortably beyond both the 400-day plausibility
    // bound and any subprocess scheduling delay, so this integration-level
    // check never depends on millisecond timing.
    const forgedSourceAuth = usableAuthJson({
      marker: "forged",
      expiresAt: new Date(now + 500 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const code = await runDecision({ sourceAuth: forgedSourceAuth, destinationAuth });
    expect(code).toBe(IMPLAUSIBLE_EXPIRY);
  });
});
