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
  COPY_BACK_AGY_CONVERSATION_LIMITS,
  copyBackAgyAuth,
  resolveAgyApiKey,
  resolveAgyCliHomeDir,
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
  /** Conversation ids this run resumes; only their brain/ state is staged. */
  resumeConversationIds?: string[];
  /**
   * Reads the conversation id(s) this run created, at teardown time. The
   * restore callback calls it when the copy-back runs, so the allowed set
   * covers both the resumed conversations and the one the CLI created.
   */
  getRunConversationIds?: () => string[];
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
 * Quote a value for safe interpolation into a POSIX shell command.
 * Single quotes stop every expansion ($, backticks, globbing); an embedded
 * single quote is closed, escaped as a double-quoted quote, and reopened.
 * Same implementation as the adapter-utils helpers (remote-pid-lock,
 * command-managed-runtime, git-workspace-sync, sandbox-managed-runtime).
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export interface RemoteMcpHomeSetupCommandInput {
  isolatedHomeDir: string;
  isolatedConfigDir: string;
  stagedMcpFile: string;
  targetMcpConfig: string;
  realGeminiDir: string | null;
  realConfigDir: string | null;
}

/**
 * Build the shell command that configures the isolated per-run MCP home on
 * a remote target. Pure (no I/O) so the quoting is unit-testable. Every
 * path is shellQuote'd: JSON.stringify's double quotes still let `$` and
 * backticks expand, so a remote home containing them would send the MCP
 * file to the wrong directory or run an injected command. The glob in the
 * config loop stays outside the quotes so `*` still expands.
 */
export function buildRemoteMcpHomeSetupCommand(input: RemoteMcpHomeSetupCommandInput): string {
  const {
    isolatedHomeDir,
    isolatedConfigDir,
    stagedMcpFile,
    targetMcpConfig,
    realGeminiDir,
    realConfigDir,
  } = input;
  return `mkdir -p ${shellQuote(isolatedConfigDir)}; ${realGeminiDir ? `ln -s ${shellQuote(path.posix.join(realGeminiDir, "antigravity-cli"))} ${shellQuote(path.posix.join(isolatedHomeDir, ".gemini", "antigravity-cli"))} 2>/dev/null || true; ln -s ${shellQuote(path.posix.join(realGeminiDir, "antigravity"))} ${shellQuote(path.posix.join(isolatedHomeDir, ".gemini", "antigravity"))} 2>/dev/null || true; ` : ""}${realConfigDir ? `if [ -d ${shellQuote(realConfigDir)} ]; then for e in ${shellQuote(realConfigDir)}/*; do if [ -e "$e" ] && [ "$(basename "$e")" != "mcp_config.json" ]; then ln -s "$e" ${shellQuote(isolatedConfigDir)}/ 2>/dev/null || true; fi; done; fi; ` : ""}cp -a ${shellQuote(stagedMcpFile)} ${shellQuote(targetMcpConfig)}`;
}

/**
 * Copy a remote run's Antigravity conversation state (brain/) back to the
 * host CLI home at teardown. The asset restore context can only read single
 * files, so a remote `find` first writes a NUL-separated manifest of the
 * brain/ files; each entry is validated to stay under brain/ before it is
 * read and written to the host. Best-effort: a missing brain/ dir, a failed
 * command, or any read/write error only loses the resume (the status quo),
 * never the run.
 *
 * Each manifest record carries the file's declared size
 * ("<bytes>\t<relative-path>"), and the manifest itself is capped with
 * `head -c` (maxFiles records at 512 bytes each), so the byte limits are
 * enforced BEFORE any download: a large artifact under brain/ cannot
 * exhaust server memory despite the advertised limits.
 */
const AGY_BRAIN_MANIFEST_NAME = ".paperclip-brain-manifest";
/** Generous per-record bound for the manifest cap (a brain/ path is short). */
const AGY_BRAIN_MANIFEST_BYTES_PER_RECORD = 512;

export interface CopyBackAgyConversationStateInput {
  /** Remote staged CLI home dir (posix path inside the sandbox). */
  assetDir: string;
  /** Host CLI home dir the brain/ tree is copied back into. */
  hostCliHomeDir: string;
  /** Runs a shell command on the remote target; returns its exit code. */
  runRemoteCommand: (command: string) => Promise<{ exitCode: number | null }>;
  /** Reads a single file back from the remote target. */
  readFile: (remotePath: string) => Promise<Buffer>;
  log: (line: string) => void | Promise<void>;
  /**
   * Conversation ids this run owns (resumed + created). When set, only
   * brain/ entries under those ids are copied back: the sandbox chooses
   * the manifest, so an unscoped copy would let it overwrite another
   * agent's conversation state on the shared host home. When unset, every
   * confined entry is copied (the previous behavior).
   */
  allowedConversationIds?: string[];
  limits?: Partial<typeof COPY_BACK_AGY_CONVERSATION_LIMITS>;
}

export async function copyBackAgyConversationState(
  input: CopyBackAgyConversationStateInput,
): Promise<void> {
  const { assetDir, hostCliHomeDir, runRemoteCommand, readFile, log } = input;
  const limits = { ...COPY_BACK_AGY_CONVERSATION_LIMITS, ...(input.limits ?? {}) };
  try {
    const brainRemote = path.posix.join(assetDir, "brain");
    const manifestRemote = path.posix.join(assetDir, AGY_BRAIN_MANIFEST_NAME);
    const manifestMaxBytes = limits.maxFiles * AGY_BRAIN_MANIFEST_BYTES_PER_RECORD;
    await runRemoteCommand(
      // POSIX sh only (the remote runs `sh -c`): the sizes come from `wc -c`
      // inside a `find -exec sh -c` loop, so paths with spaces or newlines
      // stay intact as separate argv entries, and the manifest is capped
      // with `head -c` before it is ever loaded.
      `if [ -d ${shellQuote(brainRemote)} ]; then (cd ${shellQuote(brainRemote)} && find . -type f -exec sh -c 'for f; do printf "%s\\t%s\\0" "$(wc -c < "$f" | tr -d " ")" "$f"; done' sh {} + | head -c ${manifestMaxBytes} > ${shellQuote(manifestRemote)}); fi`,
    );
    let manifest: Buffer;
    try {
      manifest = await readFile(manifestRemote);
    } catch (error) {
      // No manifest means the remote had no brain/ dir (the `[ -d ]` guard
      // skipped the find): nothing to copy back.
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
      throw error;
    }
    // Records are "<declared-bytes>\t<relative-path>", NUL-separated. A
    // record without a usable size is skipped: sizes are enforced before
    // any download, so a large artifact cannot exhaust server memory.
    const records = manifest
      .toString("utf8")
      .split("\0")
      .map((record) => {
        const tab = record.indexOf("\t");
        if (tab <= 0) return null;
        const size = Number(record.slice(0, tab).trim());
        if (!Number.isInteger(size) || size < 0) return null;
        const entry = record.slice(tab + 1);
        return { size, entry: entry.startsWith("./") ? entry.slice(2) : entry };
      })
      .filter(
        (record): record is { size: number; entry: string } =>
          record !== null && record.entry.length > 0,
      );
    if (records.length > limits.maxFiles) {
      await log(
        `[paperclip] Antigravity conversation copy-back: ${records.length} brain files, keeping the first ${limits.maxFiles}.`,
      );
    }
    const hostBrainDir = path.join(hostCliHomeDir, "brain");
    let totalBytes = 0;
    let skippedForeignEntries = 0;
    for (const { size, entry } of records.slice(0, limits.maxFiles)) {
      // Confine every entry to brain/: no absolute paths, no `..` segments,
      // and the resolved host path must stay under the host brain dir.
      if (path.posix.isAbsolute(entry) || entry.split("/").includes("..")) continue;
      // Only the run's own conversations come back: the first path segment
      // is the conversation id, and anything outside the allowed set is
      // another agent's state on the shared host home.
      if (input.allowedConversationIds) {
        const conversationId = entry.split("/")[0];
        if (!input.allowedConversationIds.includes(conversationId)) {
          skippedForeignEntries++;
          continue;
        }
      }
      const remotePath = path.posix.join(brainRemote, entry);
      const hostPath = path.join(hostBrainDir, ...entry.split("/"));
      if (!hostPath.startsWith(hostBrainDir + path.sep)) continue;
      // Enforce the byte limits on the DECLARED size, before downloading:
      // the read below is the allocation the limits are meant to bound.
      if (size > limits.maxFileBytes) continue;
      if (totalBytes + size > limits.maxTotalBytes) {
        await log("[paperclip] Antigravity conversation copy-back: hit the total size limit, stopping.");
        break;
      }
      let content: Buffer;
      try {
        content = await readFile(remotePath);
      } catch {
        continue;
      }
      // The file may have grown between the manifest and the read; enforce
      // the limits on the bytes actually received as well.
      if (content.byteLength > limits.maxFileBytes) continue;
      if (totalBytes + content.byteLength > limits.maxTotalBytes) {
        await log("[paperclip] Antigravity conversation copy-back: hit the total size limit, stopping.");
        break;
      }
      try {
        await fs.mkdir(path.dirname(hostPath), { recursive: true });
        await fs.writeFile(hostPath, content, { mode: 0o600 });
        totalBytes += content.byteLength;
      } catch {
        continue;
      }
    }
    if (skippedForeignEntries > 0) {
      await log(
        `[paperclip] Antigravity conversation copy-back: skipped ${skippedForeignEntries} brain file(s) outside this run's conversations.`,
      );
    }
  } catch (error) {
    await log(
      `[paperclip] Antigravity conversation copy-back failed: ${error instanceof Error ? error.message : String(error)}; the next run will start a fresh conversation.`,
    );
  }
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
    // Capture the host CLI home NOW: remote setup below replaces the
    // CLI-home variables in `env` with remote paths and then copies them
    // into `runtimeEnv`, so resolving it again inside the restore callback
    // would point the conversation copy-back at the remote asset dir on
    // the controller instead of the real host CLI home.
    const hostCliHomeDir = resolveAgyCliHomeDir(runtimeEnv.HOME || os.homedir(), runtimeEnv);
    // Whether a host OAuth token is staged into the sandbox. An API-key
    // run authenticates with the key, so the operator's personal OAuth
    // token must not be copied into the tenant sandbox, where agent code
    // could read it even though the CLI never uses it. The same flag gates
    // the copy-back: with no staged token there is nothing to refresh, and
    // a missing host destination must not let sandbox bytes become the
    // host credential.
    const stagedToken = !resolveAgyApiKey(runtimeEnv);
    stagedAgyHomeDir = await stageAgyHomeForSync({
      homedir: runtimeEnv.HOME || os.homedir(),
      env: runtimeEnv,
      runId,
      conversationIds: input.resumeConversationIds,
      includeOAuthToken: stagedToken,
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
              stagedTokenPresent: stagedToken,
              log: (line) => onLog("stdout", `${line}\n`),
              env: process.env,
            });
            // The staged home also holds the run's conversation state
            // (brain/); copy it back to the host CLI home so the next run
            // can resume the same conversation instead of starting fresh.
            // The sandbox chooses the manifest, so the copy is scoped to
            // this run's own conversations (resumed + created): anything
            // else is another agent's state on the shared host home.
            await copyBackAgyConversationState({
              assetDir,
              hostCliHomeDir,
              allowedConversationIds: [
                ...(input.resumeConversationIds ?? []),
                ...(input.getRunConversationIds?.() ?? []),
              ],
              runRemoteCommand: (command) =>
                runAdapterExecutionTargetShellCommand(runId, executionTarget, command, {
                  cwd: assetDir,
                  env,
                  timeoutSec,
                  graceSec,
                  onLog,
                }),
              readFile,
              log: (line) => onLog("stdout", `${line}\n`),
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

      // runAdapterExecutionTargetShellCommand returns the exit code as data
      // (it does not throw on a failed command), so a failed mkdir or cp
      // must fail setup here: otherwise the run starts against a missing
      // MCP home and logs success for servers that were never installed.
      const setupResult = await runAdapterExecutionTargetShellCommand(
        runId,
        executionTarget,
        buildRemoteMcpHomeSetupCommand({
          isolatedHomeDir,
          isolatedConfigDir,
          stagedMcpFile,
          targetMcpConfig,
          realGeminiDir,
          realConfigDir,
        }),
        { cwd: effectiveExecutionCwd, env, timeoutSec, graceSec, onLog },
      );
      if (setupResult.exitCode !== 0) {
        throw new Error(
          `Failed to configure isolated Antigravity MCP home on the remote target (exit ${setupResult.exitCode ?? "unknown"}); expected the run's MCP config at ${targetMcpConfig}.`,
        );
      }
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
