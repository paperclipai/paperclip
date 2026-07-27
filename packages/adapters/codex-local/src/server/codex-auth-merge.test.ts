import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
} from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { buildCodexAuthInboundProvision } from "./codex-auth-merge-scripts.js";

const execFile = promisify(execFileCallback);

describe("codex home auth merge on sandbox asset extract", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: {
    accountId: string;
    lastRefresh?: string;
    marker: string;
  }): string {
    return JSON.stringify({
      tokens: {
        id_token: `id-token-${input.marker}`,
        access_token: `access-token-${input.marker}`,
        refresh_token: `refresh-token-${input.marker}`,
        account_id: input.accountId,
      },
      ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
    }, null, 2);
  }

  function apiKeyAuth(marker: string): string {
    return JSON.stringify({ OPENAI_API_KEY: `sk-${marker}` }, null, 2);
  }

  async function runCodexHomeAssetExtract(input: {
    sandboxAuth: string;
    hostAuth: string;
  }): Promise<{
    commandText: string;
    writtenPaths: string[];
    finalAuth: string;
    finalMode: number;
    combinedOutput: string;
  }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-merge-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const localHomeDir = path.join(rootDir, "local-codex-home");
    const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(localHomeDir, { recursive: true });
    await mkdir(remoteHomeDir, { recursive: true });
    await writeFile(path.join(localWorkspaceDir, "README.md"), "workspace\n", "utf8");
    await writeFile(path.join(localHomeDir, "auth.json"), input.hostAuth, { mode: 0o600 });
    await writeFile(path.join(localHomeDir, "config.toml"), "model = \"gpt\"\n", "utf8");
    await writeFile(path.join(remoteHomeDir, "auth.json"), input.sandboxAuth, { mode: 0o600 });

    const commands: string[] = [];
    const outputs: string[] = [];
    const writtenPaths: string[] = [];
    const client: SandboxManagedRuntimeClient = {
      makeDir: async (remotePath) => {
        await mkdir(remotePath, { recursive: true });
      },
      writeFile: async (remotePath, bytes) => {
        writtenPaths.push(remotePath);
        await mkdir(path.dirname(remotePath), { recursive: true });
        await writeFile(remotePath, Buffer.from(bytes));
      },
      readFile: async (remotePath) => await readFile(remotePath),
      listFiles: async () => [],
      remove: async (remotePath) => {
        await rm(remotePath, { recursive: true, force: true });
      },
      run: async (command) => {
        commands.push(command);
        const result = await execFile("sh", ["-c", command], { maxBuffer: 32 * 1024 * 1024 });
        outputs.push(result.stdout, result.stderr);
      },
    };

    await prepareSandboxManagedRuntime({
      spec: {
        transport: "sandbox",
        provider: "test",
        sandboxId: "sandbox-1",
        remoteCwd: remoteWorkspaceDir,
        timeoutMs: 30_000,
        apiKey: null,
      },
      adapterKey: "codex",
      client,
      workspaceLocalDir: localWorkspaceDir,
      assets: [{
        key: "home",
        localDir: localHomeDir,
        followSymlinks: true,
        // The Codex inbound auth-merge rides the generic per-asset `provision`
        // seam. This matrix drives the sandbox core directly, supplying the same
        // contribution the codex adapter (`execute.ts`) attaches in production —
        // proving the seam reproduces inbound behavior.
        provision: buildCodexAuthInboundProvision(),
      }],
    });

    const commandText = commands.find((command) => command.includes("codex-auth-merge-extract.sh")) ?? "";
    const finalAuthPath = path.join(remoteHomeDir, "auth.json");
    return {
      commandText,
      writtenPaths,
      finalAuth: await readFile(finalAuthPath, "utf8"),
      finalMode: (await lstat(finalAuthPath)).mode & 0o777,
      combinedOutput: outputs.join("\n"),
    };
  }

  it("keeps a newer same-account sandbox auth.json and installs it atomically with mode 0600", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T02:00:00Z",
      marker: "sandbox-newer-SENTINEL",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T01:00:00Z",
      marker: "host-older-SENTINEL",
    });

    const result = await runCodexHomeAssetExtract({ sandboxAuth, hostAuth });

    expect(result.finalAuth).toBe(sandboxAuth);
    expect(result.finalMode).toBe(0o600);
    expect(result.combinedOutput).not.toContain("SENTINEL");
    expect(result.commandText).not.toContain("SENTINEL");
    expect(result.commandText).toContain("codex-auth-merge-extract.sh");
    expect(result.commandText).not.toContain("paperclip-extract");
    expect(result.commandText).not.toContain("node -");
    expect(result.commandText).not.toContain("target_tmp=");
    expect(result.commandText).not.toContain("mv -f");
    expect(result.writtenPaths.some((entry) => entry.endsWith("codex-auth-merge-extract.sh"))).toBe(true);
    expect(result.writtenPaths.some((entry) => entry.endsWith("codex-auth-merge-decision.cjs"))).toBe(true);
  });

  it("installs same-account host auth when host last_refresh is strictly newer", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T01:00:00Z",
      marker: "sandbox-older",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T02:00:00Z",
      marker: "host-newer",
    });

    const result = await runCodexHomeAssetExtract({ sandboxAuth, hostAuth });

    expect(result.finalAuth).toBe(hostAuth);
    expect(result.finalMode).toBe(0o600);
  });

  it("installs host auth on identity mismatch, auth-mode mismatch, apikey mode, and unusable sandbox auth", async () => {
    const cases = [
      {
        name: "identity mismatch",
        sandboxAuth: subscriptionAuth({
          accountId: "acct-b",
          lastRefresh: "2026-07-09T03:00:00Z",
          marker: "sandbox-account-b",
        }),
        hostAuth: subscriptionAuth({
          accountId: "acct-a",
          lastRefresh: "2026-07-09T01:00:00Z",
          marker: "host-account-a",
        }),
      },
      {
        name: "auth-mode mismatch",
        sandboxAuth: subscriptionAuth({
          accountId: "acct-a",
          lastRefresh: "2026-07-09T03:00:00Z",
          marker: "sandbox-subscription",
        }),
        hostAuth: apiKeyAuth("host-api-key"),
      },
      {
        name: "both apikey",
        sandboxAuth: apiKeyAuth("sandbox-api-key"),
        hostAuth: apiKeyAuth("host-api-key"),
      },
      {
        name: "sandbox account id missing",
        sandboxAuth: JSON.stringify({
          tokens: {
            id_token: "id-token-sandbox",
            access_token: "access-token-sandbox",
            refresh_token: "refresh-token-sandbox",
          },
          last_refresh: "2026-07-09T03:00:00Z",
        }),
        hostAuth: subscriptionAuth({
          accountId: "acct-a",
          lastRefresh: "2026-07-09T01:00:00Z",
          marker: "host-account-a",
        }),
      },
    ];

    for (const entry of cases) {
      const result = await runCodexHomeAssetExtract({
        sandboxAuth: entry.sandboxAuth,
        hostAuth: entry.hostAuth,
      });
      expect(result.finalAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalMode, entry.name).toBe(0o600);
    }
  });

  it("keeps host auth when the sandbox copy is not strictly newer (equal, missing, or unparseable freshness)", async () => {
    // The extract path stages the sandbox copy as `source` and the host copy as
    // `destination`. The decision predicate only adopts the source when it is
    // strictly fresher, so a tie, a missing last_refresh on either side, or an
    // unparseable stamp all fall through to the host destination.
    const cases = [
      {
        name: "equal last_refresh",
        sandboxAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "2026-07-09T02:00:00Z",
          marker: "sandbox-equal",
        }),
        hostAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "2026-07-09T02:00:00Z",
          marker: "host-equal",
        }),
      },
      {
        name: "missing sandbox last_refresh",
        sandboxAuth: subscriptionAuth({
          accountId: "acct-same",
          marker: "sandbox-missing-refresh",
        }),
        hostAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "2026-07-09T02:00:00Z",
          marker: "host-refresh",
        }),
      },
      {
        name: "missing host last_refresh",
        sandboxAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "2026-07-09T02:00:00Z",
          marker: "sandbox-refresh",
        }),
        hostAuth: subscriptionAuth({
          accountId: "acct-same",
          marker: "host-missing-refresh",
        }),
      },
      {
        name: "unparseable sandbox last_refresh",
        sandboxAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "not-a-date",
          marker: "sandbox-bad-refresh",
        }),
        hostAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "2026-07-09T02:00:00Z",
          marker: "host-refresh",
        }),
      },
      {
        name: "unparseable host last_refresh",
        sandboxAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "2026-07-09T02:00:00Z",
          marker: "sandbox-refresh",
        }),
        hostAuth: subscriptionAuth({
          accountId: "acct-same",
          lastRefresh: "not-a-date",
          marker: "host-bad-refresh",
        }),
      },
    ];

    for (const entry of cases) {
      const result = await runCodexHomeAssetExtract({
        sandboxAuth: entry.sandboxAuth,
        hostAuth: entry.hostAuth,
      });
      expect(result.finalAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalMode, entry.name).toBe(0o600);
    }
  });

  it("installs unusable host auth instead of serving leftover sandbox auth", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-a",
      lastRefresh: "2026-07-09T03:00:00Z",
      marker: "sandbox-valid-SENTINEL",
    });
    const cases = [
      {
        name: "invalid JSON",
        hostAuth: "{not valid json",
      },
      {
        name: "partial subscription",
        hostAuth: JSON.stringify({
          tokens: {
            account_id: "acct-b",
          },
          last_refresh: "2026-07-09T02:00:00Z",
        }),
      },
      {
        name: "top-level access token",
        hostAuth: JSON.stringify({
          access_token: "top-level-parser-differential-token",
        }),
      },
    ];

    for (const entry of cases) {
      const result = await runCodexHomeAssetExtract({
        sandboxAuth,
        hostAuth: entry.hostAuth,
      });
      expect(result.finalAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalAuth, entry.name).not.toBe(sandboxAuth);
      expect(result.finalMode, entry.name).toBe(0o600);
      expect(result.combinedOutput, entry.name).not.toContain("SENTINEL");
      expect(result.commandText, entry.name).not.toContain("SENTINEL");
    }
  });
});

// The extract shell script consumes the decision predicate as a child process
// and only branches on its exit code (10 = use the source auth.json, 20 = keep
// the destination auth.json). The predicate is direction-agnostic: the caller
// decides which file is `source` and which is `destination` by argument order
// (first = source, second = destination), so there is no `--direction` flag.
// This suite drives the `.cjs` directly the same way, asserting the exit code
// per row. Both the inbound restore (extract.sh: source = the sandbox copy,
// destination = the host copy) and the future outbound copy-back guard reduce to
// the same single question — adopt the source only when it is strictly newer,
// same-identity, subscription-kind.
describe("codex-auth-merge-decision predicate (source/destination)", () => {
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

  const KEEP_DESTINATION = 20;
  const USE_SOURCE = 10;

  function subscriptionAuth(input: {
    accountId: string;
    lastRefresh?: string;
    marker?: string;
  }): string {
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

  async function runDecision(input: {
    sourceAuth: string;
    destinationAuth: string;
  }): Promise<{ code: number; output: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-decision-"));
    cleanupDirs.push(dir);
    const sourcePath = path.join(dir, "source-auth.json");
    const destinationPath = path.join(dir, "destination-auth.json");
    await writeFile(sourcePath, input.sourceAuth, { mode: 0o600 });
    await writeFile(destinationPath, input.destinationAuth, { mode: 0o600 });

    // Arg order is the whole contract: first = source, second = destination.
    const args = [decisionScriptPath, sourcePath, destinationPath];

    try {
      const result = await execFile("node", args);
      return { code: 0, output: `${result.stdout}\n${result.stderr}` };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      if (typeof failure.code === "number") return { code: failure.code, output };
      throw error;
    }
  }

  const NEWER = "2026-07-09T02:00:00Z";
  const OLDER = "2026-07-09T01:00:00Z";

  const cases: { name: string; sourceAuth: string; destinationAuth: string; expected: number }[] = [
    {
      name: "source strictly newer, same identity → use source",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER }),
      expected: USE_SOURCE,
    },
    {
      name: "equal last_refresh (tie) → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER, marker: "src" }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER, marker: "dst" }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "source older → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "identity mismatch even when source newer → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct-source", lastRefresh: NEWER }),
      destinationAuth: subscriptionAuth({ accountId: "acct-destination", lastRefresh: OLDER }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "source last_refresh missing → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct" }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "destination last_refresh missing → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: subscriptionAuth({ accountId: "acct" }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "both last_refresh missing → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct" }),
      destinationAuth: subscriptionAuth({ accountId: "acct" }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "source last_refresh unparseable → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "not-a-date" }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "destination last_refresh unparseable → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "not-a-date" }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "source apikey → keep destination",
      sourceAuth: apiKeyAuth("source"),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "destination apikey → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: apiKeyAuth("destination"),
      expected: KEEP_DESTINATION,
    },
    {
      name: "both apikey → keep destination",
      sourceAuth: apiKeyAuth("source"),
      destinationAuth: apiKeyAuth("destination"),
      expected: KEEP_DESTINATION,
    },
    {
      name: "kind mismatch (source subscription, destination apikey) → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: apiKeyAuth("destination"),
      expected: KEEP_DESTINATION,
    },
    {
      name: "source unusable JSON → keep destination",
      sourceAuth: "{not valid json",
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER }),
      expected: KEEP_DESTINATION,
    },
    {
      name: "destination unusable JSON → keep destination",
      sourceAuth: subscriptionAuth({ accountId: "acct", lastRefresh: NEWER }),
      destinationAuth: "{not valid json",
      expected: KEEP_DESTINATION,
    },
  ];

  for (const entry of cases) {
    it(entry.name, async () => {
      const result = await runDecision({
        sourceAuth: entry.sourceAuth,
        destinationAuth: entry.destinationAuth,
      });
      expect(result.code).toBe(entry.expected);
    });
  }

  it("never emits source token bytes", async () => {
    const result = await runDecision({
      sourceAuth: subscriptionAuth({
        accountId: "acct",
        lastRefresh: NEWER,
        marker: "SECRET-SENTINEL",
      }),
      destinationAuth: subscriptionAuth({ accountId: "acct", lastRefresh: OLDER }),
    });
    expect(result.code).toBe(USE_SOURCE);
    expect(result.output).not.toContain("SENTINEL");
  });
});
