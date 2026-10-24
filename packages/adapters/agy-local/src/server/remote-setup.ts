import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterRuntimeMcpServer,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetUsesManagedHome,
  describeAdapterExecutionTarget,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTargetHomeDir,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { refreshPaperclipWorkspaceEnvForExecution } from "@paperclipai/adapter-utils/server-utils";
import {
  copyBackAgyAuth,
  resolveAgyOAuthTokenPath,
  stageAgyHomeForSync,
} from "./credentials.js";
import { stageAgyMcpConfigForSync } from "./mcp.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

export interface PrepareAgyRemoteRunInput {
  runId: string;
  executionTarget: AdapterExecutionTarget | null;
  cwd: string;
  command: string;
  timeoutSec: number;
  graceSec: number;
  runtimeCommandSpec: AdapterExecutionContext["runtimeCommandSpec"];
  onLog: AdapterExecutionContext["onLog"];
  onRuntimeProgress: AdapterExecutionContext["onRuntimeProgress"];
  runtimeEnv: Record<string, string>;
  env: Record<string, string>;
  envConfig: Record<string, unknown>;
  runtimeMcpServers: AdapterRuntimeMcpServer[];
  skillsAssetDir: string | null;
  effectiveExecutionCwd: string;
  workspaceCwd: string;
  workspaceSource: string;
  workspaceId: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  workspaceHints: Record<string, unknown>[];
  agentHome: string;
}

export interface PreparedAgyRemoteRun {
  restoreRemoteWorkspace: (() => Promise<void>) | null;
  remoteRuntimeRootDir: string | null;
  remoteSkillsDir: string | null;
  stagedAgyHomeDir: string | null;
  stagedMcpConfigDir: string | null;
  effectiveExecutionCwd: string;
  cleanupSetupFailure: () => Promise<void>;
}

/**
 * Remote-run setup for agy_local: stage the Antigravity home and MCP
 * config on the controller, sync the workspace and runtime assets to the
 * target, and wire the run environment (CLI homes pointed at the staged
 * asset dir, isolated per-run HOME carrying the run's MCP config). Extracted from
 * execute.ts so the executor stays reviewable; behavior is unchanged.
 */
export async function prepareAgyRemoteRun(
  input: PrepareAgyRemoteRunInput,
): Promise<PreparedAgyRemoteRun> {
  const {
    runId,
    executionTarget,
    cwd,
    command,
    timeoutSec,
    graceSec,
    onLog,
    runtimeEnv,
    env,
    envConfig,
    runtimeMcpServers,
    skillsAssetDir,
    workspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
  } = input;

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let remoteSkillsDir: string | null = null;
  let stagedAgyHomeDir: string | null = null;
  let stagedMcpConfigDir: string | null = null;
  let effectiveExecutionCwd = input.effectiveExecutionCwd;

  // Remote setup stages credential-bearing temp directories on the
  // controller before the run starts. Any failure after staging — during
  // runtime preparation, command resolution, or bridge startup — must run
  // the same teardown as a completed run, or those files leak and the
  // remote workspace is never restored.
  const cleanupSetupFailure = async (): Promise<void> => {
    await Promise.allSettled([
      restoreRemoteWorkspace?.(),
      stagedAgyHomeDir
        ? fs.rm(stagedAgyHomeDir, { recursive: true, force: true }).catch(() => undefined)
        : Promise.resolve(),
      stagedMcpConfigDir
        ? fs.rm(stagedMcpConfigDir, { recursive: true, force: true }).catch(() => undefined)
        : Promise.resolve(),
    ]);
  };

  try {
    const hostTokenPath =
      resolveAgyOAuthTokenPath(runtimeEnv.HOME || os.homedir(), runtimeEnv) ??
      path.join(runtimeEnv.HOME || os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
    stagedAgyHomeDir = await stageAgyHomeForSync({
      homedir: runtimeEnv.HOME || os.homedir(),
      env: runtimeEnv,
      runId,
    });

    if (runtimeMcpServers.length > 0) {
      stagedMcpConfigDir = await stageAgyMcpConfigForSync({
        servers: runtimeMcpServers,
        runId,
        homedir: runtimeEnv.HOME || os.homedir(),
        env: runtimeEnv,
      });
    }

    await onLog(
      "stdout",
      `[paperclip] Syncing workspace and Antigravity runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
    );

    const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
      runId,
      target: executionTarget,
      adapterKey: "agy",
      timeoutSec,
      workspaceLocalDir: cwd,
      installCommand: input.runtimeCommandSpec?.installCommand ?? SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      onProgress: (line) => onLog("stdout", line),
      onRuntimeProgress: input.onRuntimeProgress,
      assets: [
        ...(skillsAssetDir
          ? [
              {
                key: "skills",
                localDir: skillsAssetDir,
                followSymlinks: true,
              },
            ]
          : []),
        {
          key: "agy-home",
          localDir: stagedAgyHomeDir,
          followSymlinks: true,
          restore: async ({ assetDir, readFile }: { assetDir: string; readFile: (p: string) => Promise<Buffer> }) => {
            await copyBackAgyAuth({
              readSandboxAuth: () =>
                readFile(path.posix.join(assetDir, "antigravity-oauth-token")),
              hostTokenPath,
              log: (line) => onLog("stdout", `${line}\n`),
              env: process.env,
            });
          },
        },
        ...(stagedMcpConfigDir
          ? [
              {
                key: "mcp-config",
                localDir: stagedMcpConfigDir,
                followSymlinks: true,
              },
            ]
          : []),
      ],
    });

    restoreRemoteWorkspace = () =>
      preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;

    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote: true,
      executionCwd: effectiveExecutionCwd,
    });

    remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
    remoteSkillsDir = preparedExecutionTargetRuntime.assetDirs.skills ?? null;

    const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
    const managedRemoteHomeDir =
      managedHome && preparedExecutionTargetRuntime.runtimeRootDir
        ? preparedExecutionTargetRuntime.runtimeRootDir
        : null;
    if (managedRemoteHomeDir) {
      env.HOME = managedRemoteHomeDir;
    }
    const remoteHomeDir =
      managedRemoteHomeDir ??
      (await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
        cwd: effectiveExecutionCwd,
        env,
        timeoutSec,
        graceSec,
        onLog,
      }));

    if (preparedExecutionTargetRuntime.assetDirs["agy-home"]) {
      // Point the CLI home at the staged asset directory itself. The
      // remote user's own ~/.gemini/antigravity-cli must never be
      // deleted or replaced: on SSH targets it holds their real login,
      // settings and conversation state.
      const stagedAgyHomeRemote = preparedExecutionTargetRuntime.assetDirs["agy-home"];
      env.ANTIGRAVITY_CLI_HOME = stagedAgyHomeRemote;
      env.GEMINI_CLI_HOME = stagedAgyHomeRemote;
    }

    let effectiveRemoteHomeDir = remoteHomeDir;
    if (preparedExecutionTargetRuntime.assetDirs["mcp-config"] && preparedExecutionTargetRuntime.runtimeRootDir) {
      // Every remote run gets an isolated per-run HOME under
      // runtimeRootDir. Link ~/.gemini/antigravity-cli, ~/.gemini/antigravity,
      // and any other non-MCP .gemini/config entries from the target's home,
      // and put this run's mcp_config.json in place. This gives the run its
      // assigned MCP tools without touching or clobbering the target home's
      // own ~/.gemini/config/mcp_config.json — for unmanaged targets (such as
      // SSH) that home is the remote user's real one; for managed-home
      // targets it is the runtime root shared by the workspace's runs, where
      // writing the config directly let concurrent runs replace (or restore
      // over) each other's active MCP config. Managed runs use the managed
      // root as the link source, exactly as unmanaged runs use the user's
      // real home.
      const isolatedHomeDir = path.posix.join(preparedExecutionTargetRuntime.runtimeRootDir, "home");
      const isolatedConfigDir = path.posix.join(isolatedHomeDir, ".gemini", "config");
      const stagedMcpConfigRemote = preparedExecutionTargetRuntime.assetDirs["mcp-config"];
      const targetMcpConfig = path.posix.join(isolatedConfigDir, "mcp_config.json");
      const stagedMcpFile = path.posix.join(stagedMcpConfigRemote, "mcp_config.json");
      const realGeminiDir = remoteHomeDir ? path.posix.join(remoteHomeDir, ".gemini") : null;
      const realConfigDir = remoteHomeDir ? path.posix.join(remoteHomeDir, ".gemini", "config") : null;

      await runAdapterExecutionTargetShellCommand(
        runId,
        executionTarget,
        `mkdir -p ${JSON.stringify(isolatedConfigDir)}; ${realGeminiDir ? `ln -s ${JSON.stringify(path.posix.join(realGeminiDir, "antigravity-cli"))} ${JSON.stringify(path.posix.join(isolatedHomeDir, ".gemini", "antigravity-cli"))} 2>/dev/null || true; ln -s ${JSON.stringify(path.posix.join(realGeminiDir, "antigravity"))} ${JSON.stringify(path.posix.join(isolatedHomeDir, ".gemini", "antigravity"))} 2>/dev/null || true; ` : ""}${realConfigDir ? `if [ -d ${JSON.stringify(realConfigDir)} ]; then for e in ${JSON.stringify(realConfigDir)}/*; do if [ -e "$e" ] && [ "$(basename "$e")" != "mcp_config.json" ]; then ln -s "$e" ${JSON.stringify(isolatedConfigDir)}/ 2>/dev/null || true; fi; done; fi; ` : ""}cp -a ${JSON.stringify(stagedMcpFile)} ${JSON.stringify(targetMcpConfig)}`,
        { cwd: effectiveExecutionCwd, env, timeoutSec, graceSec, onLog },
      );
      effectiveRemoteHomeDir = isolatedHomeDir;
      env.HOME = isolatedHomeDir;
      await onLog(
        "stdout",
        `[paperclip] Configured ${runtimeMcpServers.length} Paperclip-managed MCP server(s) in isolated remote ${targetMcpConfig}.\n`,
      );
    }

    Object.assign(runtimeEnv, env);
  } catch (error) {
    await cleanupSetupFailure();
    throw error;
  }

  return {
    restoreRemoteWorkspace,
    remoteRuntimeRootDir,
    remoteSkillsDir,
    stagedAgyHomeDir,
    stagedMcpConfigDir,
    effectiveExecutionCwd,
    cleanupSetupFailure,
  };
}
