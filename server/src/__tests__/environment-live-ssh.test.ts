import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  ensureSshWorkspaceReady,
  readSshEnvLabFixtureStatus,
  runSshCommand,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshConnectionConfig,
} from "@paperclipai/adapter-utils/ssh";

async function readOptionalSecret(
  value: string | undefined,
  filePath: string | undefined,
): Promise<string | null> {
  if (value && value.trim().length > 0) {
    return value;
  }
  if (filePath && filePath.trim().length > 0) {
    return await readFile(filePath, "utf8");
  }
  return null;
}

/**
 * Resolve the env-lab state path for this instance. Falls back to a temp
 * directory scoped to the test run so parallel runs don't collide.
 */
function resolveEnvLabStatePath(): string {
  const instanceRoot =
    process.env.PAPERCLIP_INSTANCE_ROOT?.trim() ||
    path.join(process.env.HOME ?? "/tmp", ".paperclip-worktrees", "instances", "live-ssh-test");
  return path.join(instanceRoot, "env-lab", "ssh-fixture", "state.json");
}

/** Attempt to build config from explicit PAPERCLIP_ENV_LIVE_SSH_* env vars. */
function tryExplicitConfig(): {
  host: string;
  port: number;
  username: string;
  remoteWorkspacePath: string;
} | null {
  const host = process.env.PAPERCLIP_ENV_LIVE_SSH_HOST?.trim() ?? "";
  const username = process.env.PAPERCLIP_ENV_LIVE_SSH_USERNAME?.trim() ?? "";
  const remoteWorkspacePath =
    process.env.PAPERCLIP_ENV_LIVE_SSH_REMOTE_WORKSPACE_PATH?.trim() ?? "";
  const port = Number.parseInt(process.env.PAPERCLIP_ENV_LIVE_SSH_PORT ?? "22", 10);

  if (!host || !username || !remoteWorkspacePath || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port, username, remoteWorkspacePath };
}

/** Try to use an already-running env-lab fixture. */
async function tryEnvLabFixture(): Promise<SshConnectionConfig | null> {
  const statePath = resolveEnvLabStatePath();
  const status = await readSshEnvLabFixtureStatus(statePath);
  if (status.running && status.state) {
    return buildSshEnvLabFixtureConfig(status.state);
  }
  return null;
}

/**
 * Start a fresh env-lab SSH fixture for this test run. Returns the config
 * and a cleanup function to stop it afterwards.
 */
async function startEnvLabForTest(): Promise<{
  config: SshConnectionConfig;
  cleanup: () => Promise<void>;
} | null> {
  const statePath = resolveEnvLabStatePath();
  try {
    const state = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(state);
    return {
      config,
      cleanup: async () => {
        await stopSshEnvLabFixture(statePath);
      },
    };
  } catch {
    return null;
  }
}

let envLabCleanup: (() => Promise<void>) | null = null;

/**
 * Resolve an SSH connection config from (in order):
 * 1. Explicit PAPERCLIP_ENV_LIVE_SSH_* env vars
 * 2. An already-running env-lab fixture
 * 3. Auto-starting an env-lab fixture
 */
async function resolveSshConfig(): Promise<SshConnectionConfig | null> {
  // 1. Explicit env vars
  const explicit = tryExplicitConfig();
  if (explicit) {
    return {
      ...explicit,
      privateKey: await readOptionalSecret(
        process.env.PAPERCLIP_ENV_LIVE_SSH_PRIVATE_KEY,
        process.env.PAPERCLIP_ENV_LIVE_SSH_PRIVATE_KEY_PATH,
      ),
      knownHosts: await readOptionalSecret(
        process.env.PAPERCLIP_ENV_LIVE_SSH_KNOWN_HOSTS,
        process.env.PAPERCLIP_ENV_LIVE_SSH_KNOWN_HOSTS_PATH,
      ),
      strictHostKeyChecking:
        (process.env.PAPERCLIP_ENV_LIVE_SSH_STRICT_HOST_KEY_CHECKING ?? "true").toLowerCase() !== "false",
    };
  }

  // 2. Already-running env-lab
  const running = await tryEnvLabFixture();
  if (running) return running;

  // 3. Auto-start env-lab
  if (process.env.PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE !== "true") {
    const started = await startEnvLabForTest();
    if (started) {
      envLabCleanup = started.cleanup;
      return started.config;
    }
  }

  return null;
}

let resolvedConfig: SshConnectionConfig | null | undefined;

const describeLiveSsh = (() => {
  // Eagerly check explicit env vars for sync skip decision.
  // If explicit vars are set, use them. Otherwise, we'll attempt env-lab in beforeAll.
  if (tryExplicitConfig()) return describe;
  // If NO_AUTO_FIXTURE is set and no explicit config, skip immediately
  if (process.env.PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE === "true") {
    console.warn(
      "Skipping live SSH smoke test. Set PAPERCLIP_ENV_LIVE_SSH_HOST, PAPERCLIP_ENV_LIVE_SSH_USERNAME, and PAPERCLIP_ENV_LIVE_SSH_REMOTE_WORKSPACE_PATH to enable it, or remove PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE to auto-start env-lab.",
    );
    return describe.skip;
  }
  // Will attempt env-lab — don't skip yet
  return describe;
})();

describeLiveSsh("live SSH environment smoke", () => {
  afterAll(async () => {
    if (envLabCleanup) {
      await envLabCleanup();
      envLabCleanup = null;
    }
  });

  it("connects to the configured SSH environment and verifies basic runtime tools", async () => {
    if (resolvedConfig === undefined) {
      resolvedConfig = await resolveSshConfig();
    }

    if (!resolvedConfig) {
      console.warn(
        "Live SSH smoke test could not resolve SSH config from env vars or env-lab fixture. Set PAPERCLIP_ENV_LIVE_SSH_NO_AUTO_FIXTURE=true to mark this suite skipped intentionally.",
      );
      return;
    }

    const config = resolvedConfig;
    const ready = await ensureSshWorkspaceReady(config);
    const quotedRemoteWorkspacePath = JSON.stringify(config.remoteWorkspacePath);
    const result = await runSshCommand(
      config,
      `cd ${quotedRemoteWorkspacePath} && which git && which tar && pwd`,
      { timeoutMs: 30000, maxBuffer: 256 * 1024 },
    );

    expect(ready.remoteCwd).toBe(config.remoteWorkspacePath);
    expect(result.stdout).toContain(config.remoteWorkspacePath);
    expect(result.stdout).toContain("git");
    expect(result.stdout).toContain("tar");
  });
});
