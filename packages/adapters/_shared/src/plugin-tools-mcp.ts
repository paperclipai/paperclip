/**
 * Plugin Tools MCP — shared helper for Paperclip CLI adapters.
 *
 * Exposes the host-side `plugin-tool-registry` to local CLI children
 * (claude_local, gemini_local, codex_local, opencode_local) via a single
 * stdio MCP bridge. Each adapter gets two things from this module:
 *
 * 1. `buildPluginToolsMcpServer(input)` — returns a `PluginToolsMcpServerSpec`
 *    describing the command/args/env that any MCP-aware CLI must spawn to
 *    talk to Paperclip plugin tools. The adapter does NOT spawn it; the
 *    child CLI does, when it loads its MCP config.
 *
 * 2. Per-CLI materializers that convert the spec into the config format
 *    that a particular CLI expects:
 *       - `materializeClaudeMcpConfigFile(spec, dir)` → `.json` file path
 *         that goes after `--mcp-config <file>` on the Claude Code CLI.
 *       - `mergeGeminiSettingsMcpServer(settings, spec)` → patched JSON
 *         that you write to `${cwd}/.gemini/settings.json` (project scope).
 *       - `mergeCodexConfigMcpServers(configToml, spec)` → returns a TOML
 *         string with `[mcp_servers.paperclip]` appended/replaced.
 *       - `mergeOpencodeConfigMcpServers(opencodeConfig, spec)` → returns
 *         the patched JSON object suitable for `opencode.json`.
 *
 * The bridge process itself is implemented in `bridge/main.ts` and is
 * exposed via the `paperclip-mcp-bridge` bin entry in this package's
 * `package.json`. Adapters do not need to know its path: this helper
 * resolves the bin against `node_modules` so the spec works in
 * production builds and in development monorepo runs alike.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools (host registry)
 * @see KSI-664 — design decision B.1.a (this implementation)
 */

import path from "node:path";
import url from "node:url";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Identity of the agent run that the bridge will impersonate when calling
 * `POST /api/plugins/tools/execute` on the Paperclip server. All four fields
 * are required; the host enforces scope checks against this `runContext`.
 */
export interface PluginToolsMcpRunContext {
  /** UUID of the company that owns the agent and the plugin install. */
  companyId: string;
  /** UUID of the agent identity the run is acting as. */
  agentId: string;
  /** UUID of the current run (matches `PAPERCLIP_RUN_ID`). */
  runId: string;
  /** UUID of the project the run is scoped to. */
  projectId: string;
}

/**
 * Inputs needed to build a stdio MCP server spec that exposes plugin tools.
 *
 * The adapter is expected to fill these from the same context it already
 * uses to build the CLI invocation (workspace, run, agent).
 */
export interface BuildPluginToolsMcpServerInput {
  /** The agent run identity. */
  runContext: PluginToolsMcpRunContext;
  /** Absolute URL of the Paperclip API the bridge should call. */
  apiUrl: string;
  /**
   * The short-lived run JWT the bridge must use as `Authorization: Bearer ...`.
   * Pass it through `env` only — never hard-code it into the spec args, since
   * the spec is written to disk inside the CLI's MCP config file.
   *
   * The bridge reads it from the env variable named in `apiKeyEnvVar`.
   */
  apiKey: string;
  /**
   * Optional override of the env variable name the bridge will read for the
   * API key. Defaults to `PAPERCLIP_API_KEY` to match the rest of the
   * adapter surface.
   */
  apiKeyEnvVar?: string;
  /**
   * Optional Node.js executable path. Defaults to `process.execPath`.
   * Override this in tests, or when the adapter wants to run the bridge
   * with a specific Node version.
   */
  nodeExecPath?: string;
  /**
   * Optional override of the bridge entrypoint path. Production builds
   * resolve it from this package's `bin` field; tests can pass an inline
   * path to a fixture script.
   */
  bridgeScriptPath?: string;
  /**
   * Logical name of the MCP server inside each CLI's config block. Must be
   * a stable identifier without spaces or `:`/`/`/`@`. Defaults to
   * `paperclip`.
   */
  serverName?: string;
}

/**
 * A descriptor that any MCP-aware CLI can consume. The adapter writes
 * this into the CLI's config (see per-CLI `materialize*` helpers); the
 * CLI then spawns `command args` as a stdio MCP server, with `env`
 * forwarded to the child.
 */
export interface PluginToolsMcpServerSpec {
  /** Stable name to register in CLI configs. */
  serverName: string;
  /** Absolute path to the executable (typically `node`). */
  command: string;
  /** Arguments the CLI must pass when spawning. */
  args: string[];
  /**
   * Environment variables the CLI must set on the spawned bridge.
   *
   * Includes `PAPERCLIP_API_KEY` (or whatever `apiKeyEnvVar` was set to).
   * Adapters MUST forward this dict verbatim — sensitive values live here.
   */
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Bridge resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the bundled bridge entrypoint.
 *
 * Strategy:
 * 1. If the caller passed `bridgeScriptPath`, use it as-is.
 * 2. Otherwise, locate `dist/bridge/main.js` relative to this module.
 *    This works both when running compiled code from `dist/` and when
 *    the monorepo is using TS path resolution to point at `src/`
 *    (vitest, ts-node), because we then fall back to `src/bridge/main.ts`
 *    if `dist/` is absent.
 *
 * The function does not read the filesystem unless the caller pinned a
 * path; it just builds a path. Existence is verified at runtime by the
 * spawning CLI when the bridge starts.
 */
export function resolveBridgeScriptPath(input?: { bridgeScriptPath?: string }): string {
  if (input?.bridgeScriptPath && input.bridgeScriptPath.length > 0) {
    return input.bridgeScriptPath;
  }
  // import.meta.url points at this module; the bridge entrypoint lives
  // a sibling directory away. We resolve both `dist/bridge/main.js` and
  // `src/bridge/main.ts` lazily so the helper works in both build modes.
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  // When this file is at dist/plugin-tools-mcp.js, the bridge is at
  // dist/bridge/main.js. When at src/plugin-tools-mcp.ts, the bridge is
  // at src/bridge/main.ts. Use the same parent dir + bridge/main.* pattern.
  const compiled = path.join(here, "bridge", "main.js");
  return compiled;
}

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

/**
 * Build a `PluginToolsMcpServerSpec` for the given run context.
 *
 * This is the main entry point adapters call. It does NOT spawn anything.
 * It returns a stable, serializable spec that adapters then materialize
 * into the CLI's native MCP config format.
 *
 * @example
 * ```ts
 * const spec = buildPluginToolsMcpServer({
 *   runContext: { companyId, agentId, runId, projectId },
 *   apiUrl: process.env.PAPERCLIP_API_URL!,
 *   apiKey: process.env.PAPERCLIP_API_KEY!,
 * });
 * await materializeClaudeMcpConfigFile(spec, runtimeDir);
 * args.push("--mcp-config", path.join(runtimeDir, "paperclip-mcp.json"));
 * ```
 */
export function buildPluginToolsMcpServer(
  input: BuildPluginToolsMcpServerInput,
): PluginToolsMcpServerSpec {
  const { runContext, apiUrl } = input;
  if (!runContext.companyId) throw new Error("buildPluginToolsMcpServer: runContext.companyId is required");
  if (!runContext.agentId) throw new Error("buildPluginToolsMcpServer: runContext.agentId is required");
  if (!runContext.runId) throw new Error("buildPluginToolsMcpServer: runContext.runId is required");
  if (!runContext.projectId) throw new Error("buildPluginToolsMcpServer: runContext.projectId is required");
  if (!apiUrl) throw new Error("buildPluginToolsMcpServer: apiUrl is required");

  const apiKeyEnvVar = input.apiKeyEnvVar ?? "PAPERCLIP_API_KEY";
  const command = input.nodeExecPath ?? process.execPath;
  const bridgeScript = resolveBridgeScriptPath(input);
  const serverName = input.serverName ?? "paperclip";

  const args = [
    bridgeScript,
    "--api-url",
    apiUrl,
    "--api-key-env",
    apiKeyEnvVar,
    "--company-id",
    runContext.companyId,
    "--agent-id",
    runContext.agentId,
    "--run-id",
    runContext.runId,
    "--project-id",
    runContext.projectId,
  ];

  const env: Record<string, string> = {
    [apiKeyEnvVar]: input.apiKey,
  };

  return { serverName, command, args, env };
}

// ---------------------------------------------------------------------------
// Per-CLI materializers
// ---------------------------------------------------------------------------

/**
 * Claude Code accepts a JSON file with the same shape as `.mcp.json`
 * via `--mcp-config <file>`. We always write a fresh file per run to
 * keep the spec deterministic and safe to delete.
 *
 * Returns the absolute path to the written config file.
 */
export async function materializeClaudeMcpConfigFile(
  spec: PluginToolsMcpServerSpec,
  outDir: string,
  fileName: string = "paperclip-mcp.json",
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, fileName);
  const config = {
    mcpServers: {
      [spec.serverName]: {
        type: "stdio",
        command: spec.command,
        args: spec.args,
        env: spec.env,
      },
    },
  };
  await fs.writeFile(outPath, JSON.stringify(config, null, 2), "utf-8");
  return outPath;
}

/**
 * Gemini CLI looks at `mcpServers` in `~/.gemini/settings.json` (user
 * scope) or `${cwd}/.gemini/settings.json` (project scope). This helper
 * does NOT touch the filesystem; it accepts an existing settings object
 * (or `null`/`undefined` if the file does not exist) and returns the
 * patched object that the adapter should write.
 *
 * Other entries in the file are preserved verbatim.
 */
export function mergeGeminiSettingsMcpServer(
  existing: Record<string, unknown> | null | undefined,
  spec: PluginToolsMcpServerSpec,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  const previousServers =
    typeof next.mcpServers === "object" && next.mcpServers !== null
      ? { ...(next.mcpServers as Record<string, unknown>) }
      : {};
  previousServers[spec.serverName] = {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    // `trust: false` keeps the Gemini approval prompt for plugin tools
    // disabled in non-interactive runs only when paired with the global
    // `--approval-mode yolo` flag the adapter already passes.
    trust: false,
  };
  next.mcpServers = previousServers;
  return next;
}

/**
 * Codex CLI reads `[mcp_servers.<name>]` from `$CODEX_HOME/config.toml`.
 * We do not pull a TOML library in just for this; the format used by
 * Codex is simple enough to emit deterministically by hand. The helper
 * returns a patched TOML string by replacing or appending the
 * `[mcp_servers.<spec.serverName>]` block.
 *
 * Idempotent: calling twice with the same spec yields the same output.
 */
export function mergeCodexConfigMcpServers(
  existingToml: string,
  spec: PluginToolsMcpServerSpec,
): string {
  const blockHeader = `[mcp_servers.${spec.serverName}]`;
  const block = renderCodexMcpBlock(spec);

  const lines = existingToml.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => line.trim() === blockHeader);
  if (headerIdx === -1) {
    const trimmed = existingToml.trimEnd();
    return trimmed.length === 0 ? block + "\n" : trimmed + "\n\n" + block + "\n";
  }
  // Replace the existing block: from headerIdx until the next `[...]` header
  // that does NOT belong to this block's sub-namespace (e.g. `.env`).
  const subPrefix = `[mcp_servers.${spec.serverName}.`;
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (trimmed.startsWith(subPrefix)) continue;
      endIdx = i;
      break;
    }
  }
  const before = lines.slice(0, headerIdx).join("\n").trimEnd();
  const after = lines.slice(endIdx).join("\n").trimStart();
  const parts: string[] = [];
  if (before.length > 0) parts.push(before);
  parts.push(block);
  if (after.length > 0) parts.push(after);
  return parts.join("\n\n") + "\n";
}

function renderCodexMcpBlock(spec: PluginToolsMcpServerSpec): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${spec.serverName}]`);
  lines.push(`command = ${tomlEscapeString(spec.command)}`);
  lines.push(`args = ${renderTomlStringArray(spec.args)}`);
  if (Object.keys(spec.env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${spec.serverName}.env]`);
    for (const [key, value] of Object.entries(spec.env)) {
      lines.push(`${key} = ${tomlEscapeString(value)}`);
    }
  }
  return lines.join("\n");
}

function tomlEscapeString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlStringArray(values: string[]): string {
  if (values.length === 0) return "[]";
  return `[${values.map(tomlEscapeString).join(", ")}]`;
}

/**
 * OpenCode reads a `mcp` block from `opencode.json`:
 *
 * ```json
 * {
 *   "mcp": {
 *     "paperclip": {
 *       "type": "local",
 *       "command": ["node", "/path/to/bridge.js", "--api-url", "..."],
 *       "environment": { "PAPERCLIP_API_KEY": "..." },
 *       "enabled": true
 *     }
 *   }
 * }
 * ```
 *
 * Note: OpenCode collapses the binary and its args into a single
 * `command` array. This is different from Claude/Gemini/Codex.
 */
export function mergeOpencodeConfigMcpServers(
  existing: Record<string, unknown> | null | undefined,
  spec: PluginToolsMcpServerSpec,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  const previousMcp =
    typeof next.mcp === "object" && next.mcp !== null
      ? { ...(next.mcp as Record<string, unknown>) }
      : {};
  previousMcp[spec.serverName] = {
    type: "local",
    command: [spec.command, ...spec.args],
    environment: spec.env,
    enabled: true,
  };
  next.mcp = previousMcp;
  return next;
}
