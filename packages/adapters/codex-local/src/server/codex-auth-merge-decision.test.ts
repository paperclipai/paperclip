import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

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
