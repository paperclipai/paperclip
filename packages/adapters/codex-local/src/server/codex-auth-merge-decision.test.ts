import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

// The exact-boundary cases below drive the predicate's pure `decide` function
// directly (via `require`, never spawning a process), so the skew bound can be
// tested to the exact millisecond without racing subprocess-spawn wall-clock
// drift. Every other case in this file drives the REAL `.cjs` through a
// spawned `node` process (no stub), matching how the wrapper invokes it in
// production.
const decisionModule = createRequire(import.meta.url)(
  fileURLToPath(new URL("./codex-auth-merge-decision.cjs", import.meta.url)),
) as {
  decide: (
    source: { kind: "subscription" | "apikey" | "unusable"; accountId?: string; lastRefresh: number | null },
    destination: { kind: "subscription" | "apikey" | "unusable"; accountId?: string; lastRefresh: number | null },
    nowMs: number,
    seedIfDestAbsent?: boolean,
  ) => number;
  USE_SOURCE: number;
  KEEP_DESTINATION: number;
  IMPLAUSIBLE_LAST_REFRESH: number;
  MAX_FUTURE_LAST_REFRESH_SKEW_MS: number;
};
const { decide, IMPLAUSIBLE_LAST_REFRESH, MAX_FUTURE_LAST_REFRESH_SKEW_MS } = decisionModule;

// This suite pins the opt-in seed mode of the single decision predicate. The
// default (no-flag) call keeps the fail-closed host-default contract unchanged.
// The leading positional `--seed-if-dest-absent` flag adds one behaviour: fill
// an ABSENT destination slot from a usable subscription source. The flag never
// relaxes the different-identity, api-key, or unusable-source guards, and a
// default two-path call can never enter seed mode.
describe("codex-auth-merge-decision predicate seed mode", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const decisionScriptPath = fileURLToPath(
    new URL("./codex-auth-merge-decision.cjs", import.meta.url),
  );

  const USE_SOURCE = 10;
  const KEEP_DESTINATION = 20;
  const NEWER = "2026-07-09T02:00:00Z";
  const OLDER = "2026-07-09T01:00:00Z";

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

  function apiKeyAuth(marker: string): string {
    return JSON.stringify({ OPENAI_API_KEY: `sk-${marker}` });
  }

  const ABSENT = Symbol("absent");

  async function runDecision(input: {
    seed?: boolean;
    sourceAuth: string;
    destinationAuth: string | typeof ABSENT;
  }): Promise<number> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-decision-"));
    cleanupDirs.push(dir);
    const sourcePath = path.join(dir, "source-auth.json");
    const destinationPath = path.join(dir, "destination-auth.json");
    await writeFile(sourcePath, input.sourceAuth, { mode: 0o600 });
    if (input.destinationAuth !== ABSENT) {
      await writeFile(destinationPath, input.destinationAuth, { mode: 0o600 });
    }
    // The flag, when present, is the leading positional argument, parsed before
    // the two path arguments.
    const args = input.seed
      ? [decisionScriptPath, "--seed-if-dest-absent", sourcePath, destinationPath]
      : [decisionScriptPath, sourcePath, destinationPath];
    try {
      await execFile("node", args);
      return 0;
    } catch (error) {
      const failure = error as { code?: unknown };
      if (typeof failure.code === "number") return failure.code;
      throw error;
    }
  }

  it("default mode keeps destination when destination is absent (host-default fail-closed)", async () => {
    const code = await runDecision({
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: ABSENT,
    });
    expect(code).toBe(KEEP_DESTINATION);
  });

  it("seed mode uses source when destination is absent and source is a usable subscription credential", async () => {
    const code = await runDecision({
      seed: true,
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: ABSENT,
    });
    expect(code).toBe(USE_SOURCE);
  });

  it("seed mode uses source when destination is unparseable and source is a usable subscription credential", async () => {
    const code = await runDecision({
      seed: true,
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: "{not valid json",
    });
    expect(code).toBe(USE_SOURCE);
  });

  it("seed mode still keeps destination when source is apikey or unusable", async () => {
    const apikeyCode = await runDecision({
      seed: true,
      sourceAuth: apiKeyAuth("source"),
      destinationAuth: ABSENT,
    });
    expect(apikeyCode).toBe(KEEP_DESTINATION);

    const unusableCode = await runDecision({
      seed: true,
      sourceAuth: "{not valid json",
      destinationAuth: ABSENT,
    });
    expect(unusableCode).toBe(KEEP_DESTINATION);
  });

  it("seed mode still keeps destination when destination holds a different account_id", async () => {
    const code = await runDecision({
      seed: true,
      sourceAuth: subscriptionAuth({ accountId: "acct-x", lastRefresh: NEWER }),
      destinationAuth: subscriptionAuth({ accountId: "acct-y", lastRefresh: OLDER }),
    });
    expect(code).toBe(KEEP_DESTINATION);
  });

  it("seed mode keeps the same-identity strictly-newer contract for a present destination", async () => {
    const newerCode = await runDecision({
      seed: true,
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER, marker: "src" }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER, marker: "dst" }),
    });
    expect(newerCode).toBe(USE_SOURCE);

    const tieCode = await runDecision({
      seed: true,
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER, marker: "src" }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER, marker: "dst" }),
    });
    expect(tieCode).toBe(KEEP_DESTINATION);
  });

  it("the leading positional --seed-if-dest-absent flag is parsed before the two path arguments; a default two-path call never enters seed mode", async () => {
    // Identical inputs; only the leading flag differs. Absent destination:
    // default keeps, seed uses source. This proves a host-default two-path call
    // (no flag) can never seed.
    const defaultCode = await runDecision({
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: ABSENT,
    });
    const seedCode = await runDecision({
      seed: true,
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: ABSENT,
    });
    expect(defaultCode).toBe(KEEP_DESTINATION);
    expect(seedCode).toBe(USE_SOURCE);
  });
});

// This suite pins the host-clock bound on the source `last_refresh`. A
// `last_refresh` records an event that already happened, so an honest value
// never sits far ahead of the host clock; only clock skew explains a small
// future value. A source that claims a value further ahead than
// `MAX_FUTURE_LAST_REFRESH_SKEW_MS` cannot be trusted, since a same-account
// sandbox that controls its own `auth.json` could otherwise pin an unbounded
// future timestamp that every later honest refresh compares as older than.
// These cases drive `decide` directly with an explicit `nowMs`, so the bound
// is proven to the exact millisecond and never depends on the real clock.
describe("codex-auth-merge-decision predicate: host-clock bound on last_refresh", () => {
  const USE_SOURCE = 10;
  const KEEP_DESTINATION = 20;

  function subscription(accountId: string, lastRefresh: number | null) {
    return { kind: "subscription" as const, accountId, lastRefresh };
  }

  it("keeps the destination when the source last_refresh sits one millisecond beyond the bound", () => {
    const nowMs = Date.now();
    const source = subscription("acct", nowMs + MAX_FUTURE_LAST_REFRESH_SKEW_MS + 1);
    const destination = subscription("acct", nowMs - 60_000);
    expect(decide(source, destination, nowMs, false)).toBe(IMPLAUSIBLE_LAST_REFRESH);
  });

  it("uses the source when the source last_refresh sits exactly at the bound", () => {
    const nowMs = Date.now();
    const source = subscription("acct", nowMs + MAX_FUTURE_LAST_REFRESH_SKEW_MS);
    const destination = subscription("acct", nowMs - 60_000);
    expect(decide(source, destination, nowMs, false)).toBe(USE_SOURCE);
  });

  it("still uses the source for an ordinary same-account, strictly-newer, past timestamp", () => {
    const nowMs = Date.now();
    const source = subscription("acct", nowMs - 60_000);
    const destination = subscription("acct", nowMs - 120_000);
    expect(decide(source, destination, nowMs, false)).toBe(USE_SOURCE);
  });

  it("measures the bound against the host clock and not against a value embedded in either payload", () => {
    // Fixed instants; only the caller-supplied `nowMs` moves between the two
    // assertions, so a passing/failing bound can only be explained by the
    // caller's clock, never by a value embedded in either payload.
    const sourceLastRefresh = 2_000_000_000_000;
    const destinationLastRefresh = 1_000_000_000_000;
    const source = subscription("acct", sourceLastRefresh);
    const destination = subscription("acct", destinationLastRefresh);

    expect(decide(source, destination, sourceLastRefresh - MAX_FUTURE_LAST_REFRESH_SKEW_MS, false)).toBe(USE_SOURCE);
    expect(decide(source, destination, sourceLastRefresh - MAX_FUTURE_LAST_REFRESH_SKEW_MS - 1, false)).toBe(
      IMPLAUSIBLE_LAST_REFRESH,
    );
  });

  it("keeps the destination for a same-identity source whose kind or account guard would otherwise fire, regardless of the bound", () => {
    // A kind mismatch or a different account_id already keeps the destination
    // before the bound runs, so an implausible source never surfaces as
    // IMPLAUSIBLE_LAST_REFRESH when a different guard already applies.
    const nowMs = Date.now();
    const implausibleLastRefresh = nowMs + MAX_FUTURE_LAST_REFRESH_SKEW_MS + 1;
    const differentAccount = decide(
      subscription("acct-x", implausibleLastRefresh),
      subscription("acct-y", nowMs - 60_000),
      nowMs,
      false,
    );
    expect(differentAccount).toBe(KEEP_DESTINATION);
  });

  // Seed mode fills an ABSENT destination slot from a usable subscription
  // source. The bound applies there too: an absent destination that got
  // seeded with an implausible future last_refresh would never be
  // refreshable again, since no later honest refresh could ever compare as
  // "strictly newer" than an unbounded future value. The seed-mode source in
  // production is the sandbox's own `auth.json`
  // (see `writeCodexAuthCacheEntry` in codex-auth-cache.ts), so this is the
  // same untrusted input the write-back guard defends against.
  it("seed mode keeps an absent destination slot absent when the source last_refresh is implausibly far in the future", () => {
    const nowMs = Date.now();
    const source = subscription("acct", nowMs + MAX_FUTURE_LAST_REFRESH_SKEW_MS + 1);
    const destination = { kind: "unusable" as const, lastRefresh: null };
    expect(decide(source, destination, nowMs, true)).toBe(IMPLAUSIBLE_LAST_REFRESH);
  });

  it("seed mode still fills an absent destination slot when the source last_refresh sits at or before the bound", () => {
    const nowMs = Date.now();
    const source = subscription("acct", nowMs + MAX_FUTURE_LAST_REFRESH_SKEW_MS);
    const destination = { kind: "unusable" as const, lastRefresh: null };
    expect(decide(source, destination, nowMs, true)).toBe(USE_SOURCE);
  });
});
