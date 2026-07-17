import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("keeps same-account sandbox auth when freshness is equal, missing, or unparseable", async () => {
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
      expect(result.finalAuth, entry.name).toBe(entry.sandboxAuth);
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
