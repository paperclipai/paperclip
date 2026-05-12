import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import type { AdapterManagedRuntimeAsset } from "@paperclipai/adapter-utils/execution-target";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const SHIM_FILENAME = "paperclip-tools-mcp-shim.bundle.js";
const MCP_CONFIG_FILENAME = "paperclip-tools-mcp.json";
const REMOTE_ASSET_KEY = "paperclip-tools-mcp";

export interface PreparedPaperclipToolsMcpLocal {
  kind: "local";
  mcpConfigPath: string;
  cleanup(): Promise<void>;
}

export interface PreparedPaperclipToolsMcpRemote {
  kind: "remote";
  asset: AdapterManagedRuntimeAsset;
  mcpConfigRemotePath: string;
  /** Render the remote-side JSON contents once the asset is synced. */
  buildRemoteMcpConfigContents(remoteAssetDir: string): string;
  remoteAssetKey: string;
  cleanup(): Promise<void>;
}

export type PreparedPaperclipToolsMcp =
  | PreparedPaperclipToolsMcpLocal
  | PreparedPaperclipToolsMcpRemote
  | null;

export interface ResolvePaperclipToolsMcpInput {
  runId: string;
  command: string;
  resolvedCommand: string;
  executionTargetIsRemote: boolean;
  /**
   * The deterministic remote dir for synced assets keyed by REMOTE_ASSET_KEY. When unknown,
   * the helper falls back to `${effectiveRemoteCwd}/.paperclip-runtime/<adapterKey>/<asset key>`,
   * which matches `runtimeAssetDir`'s fallback in @paperclipai/adapter-utils.
   */
  resolveRemoteAssetDir?(): string;
  /** Set true to skip preparation entirely (config.disablePluginToolsMcp). */
  disabled: boolean;
  /** Override the resolved shim path (test hook). */
  shimSourcePathOverride?: string;
  /** Override the probe outcome (test hook). */
  flagSupportOverride?: boolean;
}

export interface ResolvePaperclipToolsMcpOutput {
  prepared: PreparedPaperclipToolsMcp;
  reason?:
    | "disabled"
    | "no-claude-mcp-config-support"
    | "shim-missing"
    | "prepare-failed";
  warning?: string;
}

let cachedShimResolution: { exists: boolean; resolvedAt: number } | null = null;
let __shimSourcePathOverride: string | null = null;

export function __setShimSourcePathOverrideForTesting(value: string | null): void {
  __shimSourcePathOverride = value;
}

export function resolveLocalShimPath(): string {
  if (__shimSourcePathOverride) return __shimSourcePathOverride;
  return path.join(__moduleDir, SHIM_FILENAME);
}

async function shimFileExists(shimPath: string): Promise<boolean> {
  const cacheBust = cachedShimResolution && Date.now() - cachedShimResolution.resolvedAt < 60_000;
  if (cacheBust && cachedShimResolution) return cachedShimResolution.exists;
  try {
    const stat = await fs.stat(shimPath);
    cachedShimResolution = { exists: stat.isFile(), resolvedAt: Date.now() };
    return cachedShimResolution.exists;
  } catch {
    cachedShimResolution = { exists: false, resolvedAt: Date.now() };
    return false;
  }
}

const probeCache = new Map<string, Promise<boolean>>();
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Best-effort probe: spawn `<command> --help` once per resolved command and
 * grep the stdout for `--mcp-config`. Result cached per-process keyed by the
 * resolved command path. Returns true on probe failure (fail-open) so we do
 * not silently disable MCP wiring on transient errors.
 */
export async function probeClaudeSupportsMcpConfig(input: {
  command: string;
  env?: Record<string, string>;
}): Promise<boolean> {
  const key = input.command;
  const cached = probeCache.get(key);
  if (cached) return cached;
  const promise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(
        input.command,
        ["--help"],
        { env: input.env ?? process.env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (_err, stdout, stderr) => {
          const text = `${stdout ?? ""}\n${stderr ?? ""}`;
          finish(text.includes("--mcp-config"));
        },
      );
      child.on("error", () => finish(true));
    } catch {
      finish(true);
    }
  });
  probeCache.set(key, promise);
  return promise;
}

export function __clearProbeCacheForTesting(): void {
  probeCache.clear();
  cachedShimResolution = null;
}

export interface BuildMcpConfigContentsInput {
  shimAbsolutePath: string;
}

export function buildMcpConfigContents(input: BuildMcpConfigContentsInput): string {
  // env is intentionally omitted; the shim inherits PAPERCLIP_* from the Claude
  // parent process, which is the only env shape that's consistent across local
  // and remote (bridge-mediated) execution targets.
  return `${JSON.stringify(
    {
      mcpServers: {
        paperclip: {
          command: "node",
          args: [input.shimAbsolutePath],
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function makeLocalStagingDir(runId: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-claude-mcp-${runId}-`));
  return base;
}

async function safeRemoveDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Prepares Claude's MCP config so that paperclip plugin tools surface as native
 * MCP tools. The local variant writes a `mcp.json` next to the absolute shim
 * path. The remote variant prepares a staging directory containing the shim
 * file; the caller passes the directory through `prepareAdapterExecutionTargetRuntime`
 * and then writes the JSON server-side using `buildRemoteMcpConfigContents`.
 *
 * The shim file referenced here is the self-contained esbuild bundle produced
 * by `pnpm run build:shim`. Because @modelcontextprotocol/sdk and its
 * transitive deps are inlined into the bundle, shipping just the single .js
 * to a remote target is sufficient -- the remote node process does not need
 * any reachable `node_modules` to start the shim.
 */
export async function preparePaperclipToolsMcp(
  input: ResolvePaperclipToolsMcpInput,
): Promise<ResolvePaperclipToolsMcpOutput> {
  if (input.disabled) {
    return { prepared: null, reason: "disabled" };
  }

  const shimSourcePath = input.shimSourcePathOverride ?? resolveLocalShimPath();
  const exists = await shimFileExists(shimSourcePath);
  if (!exists) {
    return {
      prepared: null,
      reason: "shim-missing",
      warning: `paperclip-tools MCP shim not found at ${shimSourcePath}; skipping MCP wiring.`,
    };
  }

  const supportsFlag =
    typeof input.flagSupportOverride === "boolean"
      ? input.flagSupportOverride
      : await probeClaudeSupportsMcpConfig({ command: input.command });
  if (!supportsFlag) {
    return {
      prepared: null,
      reason: "no-claude-mcp-config-support",
      warning: `Claude CLI at "${input.resolvedCommand}" does not advertise --mcp-config; skipping paperclip-tools MCP wiring.`,
    };
  }

  if (input.executionTargetIsRemote) {
    const stagingDir = await makeLocalStagingDir(input.runId);
    try {
      await fs.copyFile(shimSourcePath, path.join(stagingDir, SHIM_FILENAME));
    } catch (err) {
      await safeRemoveDir(stagingDir);
      return {
        prepared: null,
        reason: "prepare-failed",
        warning: `Failed to stage paperclip-tools shim for remote sync: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const buildRemoteMcpConfigContents = (remoteAssetDir: string) => {
      const remoteShimPath = `${remoteAssetDir.replace(/\/+$/, "")}/${SHIM_FILENAME}`;
      return buildMcpConfigContents({ shimAbsolutePath: remoteShimPath });
    };

    const assetDirFromCaller = input.resolveRemoteAssetDir?.();
    const fallbackRemoteAssetDir = assetDirFromCaller
      ? assetDirFromCaller.replace(/\/+$/, "")
      : `.paperclip-runtime/${REMOTE_ASSET_KEY}`;
    const mcpConfigRemotePath = `${fallbackRemoteAssetDir}/${MCP_CONFIG_FILENAME}`;

    return {
      prepared: {
        kind: "remote",
        asset: {
          key: REMOTE_ASSET_KEY,
          localDir: stagingDir,
          followSymlinks: false,
        },
        remoteAssetKey: REMOTE_ASSET_KEY,
        mcpConfigRemotePath,
        buildRemoteMcpConfigContents,
        async cleanup() {
          await safeRemoveDir(stagingDir);
        },
      },
    };
  }

  const stagingDir = await makeLocalStagingDir(input.runId);
  const mcpConfigPath = path.join(stagingDir, MCP_CONFIG_FILENAME);
  await fs.writeFile(
    mcpConfigPath,
    buildMcpConfigContents({ shimAbsolutePath: shimSourcePath }),
    "utf8",
  );

  return {
    prepared: {
      kind: "local",
      mcpConfigPath,
      async cleanup() {
        await safeRemoveDir(stagingDir);
      },
    },
  };
}

export const __test = {
  buildMcpConfigContents,
  makeLocalStagingDir,
  resolveLocalShimPath,
  REMOTE_ASSET_KEY,
  SHIM_FILENAME,
  MCP_CONFIG_FILENAME,
};
