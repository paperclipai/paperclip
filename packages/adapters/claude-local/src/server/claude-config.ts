import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterEnvironmentCheck,
  AdapterRuntimeMcpServer,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetUsesManagedHome,
  maybeRunSandboxInstallCommand,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { classifyThrownErrorClass, logSandboxProbeDiagnostic } from "./probe-diagnostics.js";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  return files;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export function resolveManagedClaudeRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-runtime");
}

export async function writePaperclipClaudeMcpConfig(input: {
  stateDir: string;
  runId: string;
  servers: AdapterRuntimeMcpServer[];
}): Promise<string> {
  const configDir = path.join(input.stateDir, "runs", input.runId, "mcp");
  const configPath = path.join(configDir, "mcp-config.json");
  const usedNames = new Set<string>();
  const mcpServers: Record<string, unknown> = {};
  for (const server of input.servers) {
    let name = server.name;
    if (usedNames.has(name)) name = `${name}-${server.connectionId.slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${server.name}-${server.connectionId.slice(0, 8)}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    mcpServers[name] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  }
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return configPath;
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}

export function buildRemoteClaudeConfigMaterializationCommand(input: {
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
}): string {
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
    }),
    input.options,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Prepare the sandbox runtime that a Claude hello probe needs. The step
 * installs the Claude CLI in the sandbox when the CLI is absent, and it
 * materializes the Paperclip-managed Claude config directory. Both the CLI
 * Test lane and the ACP Test lane call this helper, so the two lanes probe
 * the same login state. The Claude CLI and the Claude ACP engine share the
 * same stored Claude login.
 *
 * The function mutates `env`: it sets `CLAUDE_CONFIG_DIR` to the managed
 * remote config directory when it materializes one. It returns the checks to
 * add to the Test result. An operator-provided `CLAUDE_CONFIG_DIR` wins, so
 * the function keeps it and skips the managed materialization.
 */
export async function prepareSandboxClaudeProbeRuntime(input: {
  runId: string;
  target: AdapterExecutionTarget | null;
  cwd: string;
  companyId?: string;
  env: Record<string, string>;
  installCommand: string;
  detectCommand: string;
  targetIsRemote: boolean;
  targetIsSandbox: boolean;
  helloProbeTimeoutSec: number;
}): Promise<AdapterEnvironmentCheck[]> {
  const checks: AdapterEnvironmentCheck[] = [];
  const installCheck = await maybeRunSandboxInstallCommand({
    runId: input.runId,
    target: input.target,
    adapterKey: "claude",
    installCommand: input.installCommand,
    detectCommand: input.detectCommand,
    env: input.env,
  });
  if (installCheck) checks.push(installCheck);

  const hasExplicitClaudeConfigDir = isNonEmptyString(input.env.CLAUDE_CONFIG_DIR);
  if (
    input.targetIsRemote &&
    adapterExecutionTargetUsesManagedHome(input.target) &&
    !hasExplicitClaudeConfigDir
  ) {
    let tempWorkspaceDir: string | null = null;
    let preparedRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | null = null;
    try {
      const seedDir = await prepareClaudeConfigSeed(process.env, async () => {}, input.companyId);
      const managedRemoteCwd =
        input.target?.kind === "remote" ? input.target.remoteCwd : input.cwd;
      tempWorkspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-claude-envtest-workspace-"),
      );
      preparedRuntime = await prepareAdapterExecutionTargetRuntime({
        runId: input.runId,
        target: input.target,
        adapterKey: "claude",
        workspaceLocalDir: tempWorkspaceDir,
        workspaceRemoteDir: managedRemoteCwd,
        timeoutSec: Math.max(1, input.helloProbeTimeoutSec),
        assets: [
          {
            key: "config-seed",
            localDir: seedDir,
            followSymlinks: true,
          },
        ],
      });
      const runtimeRootDir =
        preparedRuntime.runtimeRootDir ??
        path.posix.join(managedRemoteCwd, ".paperclip-runtime", "claude");
      const remoteClaudeConfigSeedDir =
        preparedRuntime.assetDirs["config-seed"] ??
        path.posix.join(runtimeRootDir, "config-seed");
      const remoteClaudeConfigDir = path.posix.join(runtimeRootDir, "config");
      input.env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      await materializeRemoteClaudeConfig({
        runId: input.runId,
        target: input.target,
        remoteClaudeConfigDir,
        remoteClaudeConfigSeedDir,
        options: {
          cwd: input.cwd,
          env: input.env,
          timeoutSec: Math.max(15, input.helloProbeTimeoutSec),
          graceSec: 5,
          onLog: async () => {},
        },
      });
      checks.push({
        code: "claude_managed_config_dir",
        level: "info",
        message: "The environment probe is using Paperclip-managed Claude config materialization.",
        detail: remoteClaudeConfigDir,
      });
    } catch (err) {
      // Keep the raw error out of the Test-result check and the server log. Log
      // only the fixed context, the allowlisted classification, and a safe
      // error class name.
      logSandboxProbeDiagnostic(
        "Could not materialize Paperclip-managed Claude config for the environment probe",
        "spawn_error",
        { errorClass: classifyThrownErrorClass(err) },
      );
      checks.push({
        code: "claude_managed_config_dir_failed",
        level: "error",
        message: "Could not materialize Paperclip-managed Claude config for the environment probe.",
        hint: "Retry the Test. If the failure repeats, check the server log for the redacted diagnostic.",
      });
    } finally {
      await preparedRuntime?.restoreWorkspace().catch(() => undefined);
      if (tempWorkspaceDir) {
        await fs.rm(tempWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  return checks;
}
