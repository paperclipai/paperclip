import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";

const execFile = promisify(execFileCallback);

function makeCodexSubscriptionAuth(input: {
  accountId: string;
  lastRefresh: string;
  accessToken: string;
  refreshToken: string;
}): string {
  return `${JSON.stringify({
    tokens: {
      id_token: `id-${input.accountId}`,
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      account_id: input.accountId,
    },
    last_refresh: input.lastRefresh,
  })}\n`;
}

async function writeAuthJson(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function makeLocalSandboxClient(runArtifacts: { commandText: string[]; outputText: string[] }): SandboxManagedRuntimeClient {
  return {
    makeDir: async (remotePath) => {
      await mkdir(remotePath, { recursive: true });
    },
    writeFile: async (remotePath, bytes) => {
      await mkdir(path.dirname(remotePath), { recursive: true });
      await writeFile(remotePath, Buffer.from(bytes));
    },
    readFile: async (remotePath) => await readFile(remotePath),
    listFiles: async () => [],
    remove: async (remotePath) => {
      await rm(remotePath, { recursive: true, force: true });
    },
    run: async (command) => {
      runArtifacts.commandText.push(command);
      const { stdout, stderr } = await execFile("sh", ["-c", command], {
        maxBuffer: 32 * 1024 * 1024,
      });
      runArtifacts.outputText.push(stdout, stderr);
    },
  };
}

describe("workspace restore merge", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves sibling files when sequential stale-baseline restores create the same nested directory tree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);

    const targetDir = path.join(rootDir, "target");
    const sourceADir = path.join(rootDir, "source-a");
    const sourceBDir = path.join(rootDir, "source-b");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(sourceADir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });
    await mkdir(path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await writeFile(
      path.join(sourceADir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"),
      "ssh claude\n",
      "utf8",
    );
    await writeFile(
      path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"),
      "ssh codex\n",
      "utf8",
    );

    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceADir,
      targetDir,
    });
    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceBDir,
      targetDir,
    });

    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"), "utf8"),
    ).resolves.toBe("ssh claude\n");
    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"), "utf8"),
    ).resolves.toBe("ssh codex\n");
  });

  it("ignores non-file entries when capturing snapshots", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const socketPath = path.join(rootDir, "runtime.sock");
    const server = net.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });

      expect(snapshot.entries.has("runtime.sock")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps a newer same-account Codex sandbox auth.json during home asset extract", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-merge-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");
    const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
    const sandboxAuth = makeCodexSubscriptionAuth({
      accountId: "account-1",
      lastRefresh: "2026-07-09T02:00:00.000Z",
      accessToken: "sandbox-access-token-secret",
      refreshToken: "sandbox-refresh-token-secret",
    });
    const hostAuth = makeCodexSubscriptionAuth({
      accountId: "account-1",
      lastRefresh: "2026-07-09T01:00:00.000Z",
      accessToken: "host-access-token-secret",
      refreshToken: "host-refresh-token-secret",
    });
    const runArtifacts = { commandText: [] as string[], outputText: [] as string[] };

    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeAuthJson(path.join(homeDir, "auth.json"), hostAuth);
    await writeFile(path.join(homeDir, "config.toml"), "model = \"gpt\"\n", "utf8");
    await writeAuthJson(path.join(remoteHomeDir, "auth.json"), sandboxAuth);
    await writeFile(path.join(remoteHomeDir, "stale.txt"), "remove me\n", "utf8");

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
      client: makeLocalSandboxClient(runArtifacts),
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "home", localDir: homeDir, followSymlinks: true }],
    });

    await expect(readFile(path.join(remoteHomeDir, "auth.json"), "utf8")).resolves.toBe(sandboxAuth);
    await expect(readFile(path.join(remoteHomeDir, "config.toml"), "utf8")).resolves.toBe("model = \"gpt\"\n");
    await expect(readFile(path.join(remoteHomeDir, "stale.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(remoteHomeDir, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(remoteHomeDir)).some((entry) => entry.startsWith(".auth.json.paperclip-"))).toBe(false);

    const logged = [...runArtifacts.commandText, ...runArtifacts.outputText].join("\n");
    expect(logged).not.toContain("sandbox-refresh-token-secret");
    expect(logged).not.toContain("host-refresh-token-secret");
  });

  it("installs host Codex auth on account mismatch with owner-only mode", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-host-wins-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");
    const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
    const sandboxAuth = makeCodexSubscriptionAuth({
      accountId: "account-b",
      lastRefresh: "2026-07-09T03:00:00.000Z",
      accessToken: "sandbox-access-token-secret",
      refreshToken: "sandbox-refresh-token-secret",
    });
    const hostAuth = makeCodexSubscriptionAuth({
      accountId: "account-a",
      lastRefresh: "2026-07-09T01:00:00.000Z",
      accessToken: "host-access-token-secret",
      refreshToken: "host-refresh-token-secret",
    });

    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeAuthJson(path.join(homeDir, "auth.json"), hostAuth);
    await writeAuthJson(path.join(remoteHomeDir, "auth.json"), sandboxAuth);

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
      client: makeLocalSandboxClient({ commandText: [], outputText: [] }),
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "home", localDir: homeDir, followSymlinks: true }],
    });

    await expect(readFile(path.join(remoteHomeDir, "auth.json"), "utf8")).resolves.toBe(hostAuth);
    expect((await stat(path.join(remoteHomeDir, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(remoteHomeDir)).some((entry) => entry.startsWith(".auth.json.paperclip-"))).toBe(false);
  });

  it("installs host Codex auth when sandbox auth identity is unusable", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-unusable-sandbox-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");
    const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
    const hostAuth = makeCodexSubscriptionAuth({
      accountId: "account-a",
      lastRefresh: "2026-07-09T01:00:00.000Z",
      accessToken: "host-access-token-secret",
      refreshToken: "host-refresh-token-secret",
    });

    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeAuthJson(path.join(homeDir, "auth.json"), hostAuth);
    await writeAuthJson(path.join(remoteHomeDir, "auth.json"), "{\"tokens\":{\"access_token\":\"unknown\"}}\n");

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
      client: makeLocalSandboxClient({ commandText: [], outputText: [] }),
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "home", localDir: homeDir, followSymlinks: true }],
    });

    await expect(readFile(path.join(remoteHomeDir, "auth.json"), "utf8")).resolves.toBe(hostAuth);
  });

  it("keeps sandbox Codex auth when uploaded host auth is unusable", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-unusable-host-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");
    const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
    const sandboxAuth = makeCodexSubscriptionAuth({
      accountId: "account-1",
      lastRefresh: "2026-07-09T02:00:00.000Z",
      accessToken: "sandbox-access-token-secret",
      refreshToken: "sandbox-refresh-token-secret",
    });
    const runArtifacts = { commandText: [] as string[], outputText: [] as string[] };

    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeAuthJson(path.join(homeDir, "auth.json"), "{}\n");
    await writeAuthJson(path.join(remoteHomeDir, "auth.json"), sandboxAuth);

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
      client: makeLocalSandboxClient(runArtifacts),
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "home", localDir: homeDir, followSymlinks: true }],
    });

    await expect(readFile(path.join(remoteHomeDir, "auth.json"), "utf8")).resolves.toBe(sandboxAuth);
    expect((await stat(path.join(remoteHomeDir, "auth.json"))).mode & 0o777).toBe(0o600);

    const logged = [...runArtifacts.commandText, ...runArtifacts.outputText].join("\n");
    expect(logged).toContain("uploaded host auth was unusable");
    expect(logged).not.toContain("sandbox-refresh-token-secret");
  });

  it("keeps same-account sandbox auth when freshness is ambiguous", async () => {
    if (process.platform === "win32") return;

    const cases = [
      {
        name: "equal",
        hostAuth: makeCodexSubscriptionAuth({
          accountId: "account-1",
          lastRefresh: "2026-07-09T03:00:00.000Z",
          accessToken: "host-access-token-secret",
          refreshToken: "host-refresh-token-secret",
        }),
      },
      {
        name: "missing",
        hostAuth: `${JSON.stringify({
          tokens: {
            id_token: "id-account-1",
            access_token: "host-access-token-secret",
            refresh_token: "host-refresh-token-secret",
            account_id: "account-1",
          },
        })}\n`,
      },
      {
        name: "unparseable",
        hostAuth: `${JSON.stringify({
          tokens: {
            id_token: "id-account-1",
            access_token: "host-access-token-secret",
            refresh_token: "host-refresh-token-secret",
            account_id: "account-1",
          },
          last_refresh: "not-a-date",
        })}\n`,
      },
    ];

    for (const testCase of cases) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), `paperclip-codex-auth-${testCase.name}-`));
      cleanupDirs.push(rootDir);

      const localWorkspaceDir = path.join(rootDir, "local-workspace");
      const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
      const homeDir = path.join(rootDir, "codex-home");
      const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
      const sandboxAuth = makeCodexSubscriptionAuth({
        accountId: "account-1",
        lastRefresh: "2026-07-09T03:00:00.000Z",
        accessToken: "sandbox-access-token-secret",
        refreshToken: "sandbox-refresh-token-secret",
      });

      await mkdir(localWorkspaceDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeAuthJson(path.join(homeDir, "auth.json"), testCase.hostAuth);
      await writeAuthJson(path.join(remoteHomeDir, "auth.json"), sandboxAuth);

      await prepareSandboxManagedRuntime({
        spec: {
          transport: "sandbox",
          provider: "test",
          sandboxId: `sandbox-${testCase.name}`,
          remoteCwd: remoteWorkspaceDir,
          timeoutMs: 30_000,
          apiKey: null,
        },
        adapterKey: "codex",
        client: makeLocalSandboxClient({ commandText: [], outputText: [] }),
        workspaceLocalDir: localWorkspaceDir,
        assets: [{ key: "home", localDir: homeDir, followSymlinks: true }],
      });

      await expect(readFile(path.join(remoteHomeDir, "auth.json"), "utf8")).resolves.toBe(sandboxAuth);
    }
  });

  it("installs host Codex API-key auth when auth modes differ", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-mode-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");
    const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
    const sandboxAuth = makeCodexSubscriptionAuth({
      accountId: "account-1",
      lastRefresh: "2026-07-09T03:00:00.000Z",
      accessToken: "sandbox-access-token-secret",
      refreshToken: "sandbox-refresh-token-secret",
    });
    const hostAuth = `${JSON.stringify({ OPENAI_API_KEY: "sk-host-secret" })}\n`;

    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeAuthJson(path.join(homeDir, "auth.json"), hostAuth);
    await writeAuthJson(path.join(remoteHomeDir, "auth.json"), sandboxAuth);

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
      client: makeLocalSandboxClient({ commandText: [], outputText: [] }),
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "home", localDir: homeDir, followSymlinks: true }],
    });

    await expect(readFile(path.join(remoteHomeDir, "auth.json"), "utf8")).resolves.toBe(hostAuth);
    expect((await stat(path.join(remoteHomeDir, "auth.json"))).mode & 0o777).toBe(0o600);
  });

  it("installs host Codex API-key auth when both sides use API keys", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-both-api-key-"));
    cleanupDirs.push(rootDir);

    const localWorkspaceDir = path.join(rootDir, "local-workspace");
    const remoteWorkspaceDir = path.join(rootDir, "remote-workspace");
    const homeDir = path.join(rootDir, "codex-home");
    const remoteHomeDir = path.join(remoteWorkspaceDir, ".paperclip-runtime", "codex", "home");
    const sandboxAuth = `${JSON.stringify({ OPENAI_API_KEY: "sk-sandbox-secret" })}\n`;
    const hostAuth = `${JSON.stringify({ OPENAI_API_KEY: "sk-host-secret" })}\n`;

    await mkdir(localWorkspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeAuthJson(path.join(homeDir, "auth.json"), hostAuth);
    await writeAuthJson(path.join(remoteHomeDir, "auth.json"), sandboxAuth);

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
      client: makeLocalSandboxClient({ commandText: [], outputText: [] }),
      workspaceLocalDir: localWorkspaceDir,
      assets: [{ key: "home", localDir: homeDir, followSymlinks: true }],
    });

    await expect(readFile(path.join(remoteHomeDir, "auth.json"), "utf8")).resolves.toBe(hostAuth);
    expect((await stat(path.join(remoteHomeDir, "auth.json"))).mode & 0o777).toBe(0o600);
  });
});
