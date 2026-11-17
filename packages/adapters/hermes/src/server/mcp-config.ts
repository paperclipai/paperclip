import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";

import { redactDiagnosticText, type AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  type MemoryHardeningFlags,
  resolveEffectiveMemoryHardeningFlags,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveHostHermesDir, resolveHostHermesSkillsDir } from "./skills.js";
import {
  type ValidatedHermesMemoryConfig,
  serializeMem0Json,
  generateHermesMemoryYaml,
  type HermesMemoryProvider,
  MAX_CONFIG_STRING_LENGTH,
} from "./memory-config.js";

export interface HermesMcpServerConfig {
  url: string;
  headers: {
    Authorization: string;
  };
  enabled: true;
  skip_preflight: true;
  tools: {
    resources: false;
    prompts: false;
    include: string[];
  };
}

export interface PrepareHermesMcpHomeOptions {
  /** Hosted Anthropic request bound; independent of the total run timeout. */
  anthropicRequestTimeoutSec?: number;
  servers?: AdapterRuntimeMcpServer[];
  memory?: ValidatedHermesMemoryConfig;
  config?: Record<string, unknown>;
  tempDirPrefix?: string;
  /**
   * TECH-7102: isolated (hosted) mode. Never reads or merges the host Hermes dir (.env provider
   * keys, config.yaml, auth, skills) and never creates the profile under the host profiles dir;
   * `tempDirPrefix` (inside the run home) is required.
   */
  isolatedFromHost?: boolean;
  /**
   * TECH-7895: a Ramp Router run. Inherited host `model` endpoint/credential keys are dropped so
   * the Router key only reaches Hermes's built-in Router endpoint.
   */
  canonicalRouterEndpoint?: boolean;
  flags?: MemoryHardeningFlags;
  /**
   * Validated `adapterConfig.memoryProvider`. Emits `memory.provider` into config.yaml only; no
   * `mem0.json` is written, so Hermes reads its connection settings (`MEM0_*`) from the
   * environment. Ignored when runtime memory (`memory`) is present for the run.
   */
  memoryProvider?: HermesMemoryProvider;
  /**
   * Sandbox runs: point each server at its bridge relay route (`${PAPERCLIP_API_URL}` plus
   * {@link hermesMcpRelayPath}) and authenticate with the run's bridge token (`${PAPERCLIP_API_KEY}`).
   * The server's own token is never written to the home or the pod env; the host injects it per route.
   */
  bridgeRelay?: boolean;
  onWarning?: (msg: string) => void;
}

/** The in-sandbox bridge path that relays to one Hermes MCP server key (TECH-8909). */
export function hermesMcpRelayPath(serverKey: string): string {
  return `/paperclip-relay/mcp/${serverKey}`;
}

export interface PreparedHermesMcpHome {
  homeDir: string;
  configPath: string;
  envPath: string;
  mem0JsonPath?: string;
  env: Record<string, string>;
  providerEnv: Record<string, string>;
  serverCount: number;
  /** Hermes `mcp_servers` keys, index-aligned with the `servers` option passed to prepare. */
  serverKeys: string[];
  hasMemory: boolean;
}

/**
 * Hermes >= 0.21 defers MCP tools behind a `tool_search` bridge by default (`auto`), so governed
 * tools are not direct turn-1 schema entries. Paperclip already supplies a finite per-agent
 * allowlist, so isolated profiles with a small allowlist force direct exposure
 * (`mcp__<server>__<tool>`) for first-turn reliability and auditability (see
 * `resolveHermesToolSearchSetting` for large allowlists). Quoted string, not a bare `off`, which
 * YAML 1.1 parsers read as boolean false.
 */
export const HERMES_TOOL_SEARCH_SETTING = "off";

/**
 * Direct exposure sends every allowlisted tool schema on every request, and compaction cannot
 * shrink that fixed cost. At ~250 tools it is ~220K tokens, above Hermes's compaction trigger
 * (50% of a 256K window), so the run recompacts without ever getting under the threshold
 * (TECH-8184). Above this many allowlisted tools, leave the bridge on (`auto`): Hermes then
 * sends `tool_search`/`tool_describe`/`tool_call` plus a short manifest and loads schemas on
 * demand. The allowlist still bounds what the bridge can reach (`tools.include` is applied at
 * discovery, and the preflight requires the server to list exactly the allowlist).
 */
export const HERMES_TOOL_SEARCH_DIRECT_MAX_TOOLS = 40;
export const HERMES_TOOL_SEARCH_BRIDGE_SETTING = "auto";

export function resolveHermesToolSearchSetting(allowlistedToolCount: number): string {
  return allowlistedToolCount > HERMES_TOOL_SEARCH_DIRECT_MAX_TOOLS
    ? HERMES_TOOL_SEARCH_BRIDGE_SETTING
    : HERMES_TOOL_SEARCH_SETTING;
}

/**
 * Closed allowlist of top-level keys in host `config.yaml` permitted to be inherited
 * into the isolated temporary profile configuration.
 *
 * Excludes host `mcp_servers`, `memory`, `database`/`session`/`state`, `telemetry`,
 * and browser/messaging integrations to guarantee strictly isolated, ephemeral state.
 */
export const ALLOWED_HOST_CONFIG_KEYS = new Set([
  "model",
  "provider",
  "temperature",
  "top_p",
  "max_tokens",
  "context_window",
  "code_execution",
  "command_allowlist",
  "tool_loop_guardrails",
  "prompt_caching",
  "streaming",
  "compression",
]);

/**
 * Closed allowlist of provider credential and endpoint environment variable names
 * permitted to be inherited from host `.env`.
 *
 * These variables are injected directly into the child process environment only,
 * never copied to the temporary `.env` file or logged.
 */
export const HERMES_PROVIDER_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  // Ramp Router (Hermes `router` provider, Responses API). Key only: Hermes honours its own
  // RAMP_ROUTER_BASE_URL alias, so allowlisting that here would let an agent's env redirect the
  // Router key to another host. The legacy ROUTER_API_KEY alias is deliberately not included —
  // Paperclip exposes one canonical name per provider. Do not add either "for convenience".
  "RAMP_ROUTER_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "MISTRAL_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "GROQ_API_KEY",
  "GROQ_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_HOST",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_ANTHROPIC_KEY",
  "DASHSCOPE_API_KEY",
  "GLM_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MINIMAX_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "NOUS_API_KEY",
  "NOUS_BASE_URL",
  "NOUS_PORTAL_URL",
  "ARCEEAI_API_KEY",
  "GMI_API_KEY",
  "KILOCODE_API_KEY",
  "XIAOMI_API_KEY",
  "TOKENHUB_API_KEY",
  "NOVITA_API_KEY",
  "NVIDIA_API_KEY",
  "STEPFUN_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "OPENCODE_GO_API_KEY",
  "COHERE_API_KEY",
  "BEDROCK_AWS_ACCESS_KEY_ID",
  "BEDROCK_AWS_SECRET_ACCESS_KEY",
  "BEDROCK_AWS_SESSION_TOKEN",
  "BEDROCK_AWS_REGION",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "ANYSCALE_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
  "HYPERBOLIC_API_KEY",
]);

/**
 * Validates that an MCP server definition meets security and protocol constraints.
 * Fails closed if any field contains CR/LF, invalid characters, or lacks a finite tool allowlist.
 * Rejects glob metacharacters (*, ?, [, ]) in tool names to preserve exact bare name semantics.
 */
export function validateMcpServer(server: AdapterRuntimeMcpServer): void {
  if (!server || typeof server !== "object") {
    throw new Error("Invalid MCP server: expected server object");
  }

  if (typeof server.name !== "string" || server.name.trim().length === 0) {
    throw new Error("Invalid MCP server: name must be a non-empty string");
  }
  if (server.name.length > MAX_CONFIG_STRING_LENGTH) {
    throw new Error(`Invalid MCP server name: name exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`);
  }
  if (/[\r\n\0]/.test(server.name)) {
    throw new Error(`Invalid MCP server name "${server.name}": contains control characters or newlines`);
  }

  if (typeof server.url !== "string" || !/^https?:\/\//i.test(server.url.trim())) {
    throw new Error(`Invalid MCP server URL for "${server.name}": must be an HTTP or HTTPS URL`);
  }
  if (server.url.length > MAX_CONFIG_STRING_LENGTH) {
    throw new Error(`Invalid MCP server URL for "${server.name}": URL exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`);
  }
  if (/[\r\n\0]/.test(server.url)) {
    throw new Error(`Invalid MCP server URL for "${server.name}": contains control characters or newlines`);
  }

  if (typeof server.token !== "string" || server.token.length === 0) {
    throw new Error(`Invalid MCP server token for "${server.name}": token must be non-empty`);
  }
  if (server.token.length > MAX_CONFIG_STRING_LENGTH) {
    throw new Error(`Invalid MCP server token for "${server.name}": token exceeds maximum allowed length of ${MAX_CONFIG_STRING_LENGTH} characters`);
  }
  if (/[\r\n\0]/.test(server.token)) {
    throw new Error(`Unsafe token for MCP server "${server.name}": token contains control characters or newlines`);
  }

  if (!Array.isArray(server.allowedTools) || server.allowedTools.length === 0) {
    throw new Error(`Cannot configure Hermes MCP server "${server.name}": no allowed tools provided; a finite non-empty allowlist is required`);
  }
  for (const tool of server.allowedTools) {
    if (typeof tool !== "string" || tool.trim().length === 0) {
      throw new Error(`Invalid tool name in allowlist for MCP server "${server.name}": must be a non-empty string`);
    }
    if (/[\r\n\0]/.test(tool)) {
      throw new Error(`Invalid tool name "${tool}" for MCP server "${server.name}": contains control characters or newlines`);
    }
    if (/[*?\[\]{}]/.test(tool)) {
      throw new Error(`Invalid tool name "${tool}" for MCP server "${server.name}": contains glob metacharacters (*, ?, [, ], {, })`);
    }
  }
}

/**
 * Sanitizes a server name for use as a key in Hermes `mcp_servers`.
 * Collisions are handled deterministically using the connectionId and an incrementing suffix.
 */
export function sanitizeServerKey(rawName: string, connectionId: string, usedKeys: Set<string>): string {
  const sanitized = rawName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  let key = sanitized.length > 0 ? sanitized : "mcp_server";

  if (usedKeys.has(key)) {
    const connSuffix = (connectionId || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 16);
    if (connSuffix.length > 0) {
      key = `${key}_${connSuffix}`;
    }
  }

  let counter = 2;
  const baseKey = key;
  while (usedKeys.has(key)) {
    key = `${baseKey}_${counter}`;
    counter++;
  }
  usedKeys.add(key);
  return key;
}

/**
 * Derives a deterministic environment variable name for an MCP server's bearer token.
 */
export function sanitizeEnvVarName(serverKey: string, usedEnvVars: Set<string>): string {
  const upper = serverKey.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const baseVar = `HERMES_MCP_TOKEN_${upper}`;
  let envVar = baseVar;
  let counter = 2;
  while (usedEnvVars.has(envVar)) {
    envVar = `${baseVar}_${counter}`;
    counter++;
  }
  usedEnvVars.add(envVar);
  return envVar;
}

/**
 * Safely parses and sanitizes host config YAML content using a real YAML parser.
 * Fail-closed: returns empty string if rawYaml is empty, invalid, multi-document,
 * or not a mapping/object. Retains only exact keys matching ALLOWED_HOST_CONFIG_KEYS.
 *
 * A Ramp Router run must not inherit any host endpoint or credential selector: agent config supplies
 * provider and model, and the only credential is the canonical RAMP_ROUTER_API_KEY. A denylist of
 * known keys cannot guarantee that (an unknown `key_env`, `api_key_env`, future alias or invented
 * key would survive), so a Router run drops the whole host `model` section and top-level `provider`
 * and never re-emits an empty `model: {}`.
 */
export function sanitizeHostConfigYaml(
  rawYaml: string,
  onWarning?: (msg: string) => void,
  options: { canonicalRouterEndpoint?: boolean } = {},
): string {
  if (!rawYaml || typeof rawYaml !== "string" || rawYaml.trim().length === 0) {
    return "";
  }

  let docs: YAML.Document.Parsed[];
  try {
    docs = YAML.parseAllDocuments(rawYaml);
  } catch {
    onWarning?.("Failed to parse host configuration: malformed YAML document");
    return "";
  }

  if (docs.length === 0) {
    return "";
  }

  // Reject multi-document YAML fail-closed
  if (docs.length > 1) {
    onWarning?.("Failed to inherit host configuration: multi-document YAML is not supported");
    return "";
  }

  const doc = docs[0];
  if (!doc) {
    return "";
  }

  if (doc.errors.length > 0) {
    onWarning?.("Failed to parse host configuration: malformed YAML document");
    return "";
  }

  // An empty or comment-only document has null contents (or null scalar); return empty string silently
  if (
    doc.contents === null ||
    (doc.contents && typeof doc.contents === "object" && "value" in doc.contents && doc.contents.value === null)
  ) {
    return "";
  }

  let parsed: unknown;
  try {
    parsed = doc.toJS();
  } catch {
    // Defensive fail-safe: doc.toJS() can throw on custom tags/types or circular AST structures.
    // Standard YAML syntax errors are captured earlier in doc.errors, so unit-testing this branch
    // would require brittle monkeypatching of internal parser AST structures; documenting omission per review.
    onWarning?.("Failed to parse host configuration: unable to convert YAML contents");
    return "";
  }

  // Require a mapping / plain object
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    onWarning?.("Failed to inherit host configuration: expected a mapping at the root");
    return "";
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (ALLOWED_HOST_CONFIG_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }

  if (options.canonicalRouterEndpoint) {
    // Structural, not key-by-key: drop the entire host model section and top-level provider. Agent
    // config supplies both, so nothing under them — endpoint, credential, or an unknown key — can
    // reach a Router run's profile.
    delete sanitized.model;
    delete sanitized.provider;
  }

  if (Object.keys(sanitized).length === 0) {
    return "";
  }

  return YAML.stringify(sanitized).trim();
}

/**
 * Filters host .env content through HERMES_PROVIDER_ENV_ALLOWLIST using dotenv.parse.
 */
export function filterProviderEnv(
  dotenvContent: string,
  onWarning?: (msg: string) => void,
): Record<string, string> {
  if (!dotenvContent || typeof dotenvContent !== "string") return {};

  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(dotenvContent);
  } catch {
    onWarning?.("Failed to parse host environment file");
    return {};
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (HERMES_PROVIDER_ENV_ALLOWLIST.has(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}

/**
 * Deterministically serializes Hermes MCP configuration to YAML format.
 * Quotes all strings safely to guarantee valid PyYAML parsing without third-party dependencies.
 * Emits `resources: false` and `prompts: false` to disable utility tool generation.
 */
export function serializeHermesMcpYaml(
  mcpServers: Record<string, HermesMcpServerConfig>,
  inheritedHostYaml = "",
  hasMemory = false,
  flags?: MemoryHardeningFlags,
  anthropicRequestTimeoutSec?: number,
): string {
  const lines: string[] = [];

  const trimmedHost = inheritedHostYaml.trim();
  if (trimmedHost.length > 0) {
    lines.push(trimmedHost);
    lines.push("");
  }

  if (anthropicRequestTimeoutSec !== undefined) {
    if (!Number.isFinite(anthropicRequestTimeoutSec) || anthropicRequestTimeoutSec <= 0) {
      throw new Error("Anthropic request timeout must be a positive finite number");
    }
    lines.push("providers:", "  anthropic:", `    request_timeout_seconds: ${anthropicRequestTimeoutSec}`, "");
  }

  if (hasMemory) {
    lines.push(generateHermesMemoryYaml(flags).trimEnd());
    lines.push("");
  }

  if (Object.keys(mcpServers).length > 0) {
    // Emitted by Paperclip only (host `tools` is never inherited, see ALLOWED_HOST_CONFIG_KEYS),
    // so a host config cannot change the tool_search mode.
    const allowlistedToolCount = Object.values(mcpServers).reduce(
      (total, server) => total + server.tools.include.length,
      0,
    );
    lines.push("tools:");
    lines.push("  tool_search:");
    lines.push(`    enabled: ${JSON.stringify(resolveHermesToolSearchSetting(allowlistedToolCount))}`);
    lines.push("");
    lines.push("mcp_servers:");
    for (const [key, server] of Object.entries(mcpServers)) {
      lines.push(`  ${key}:`);
      lines.push(`    url: ${JSON.stringify(server.url)}`);
      lines.push("    headers:");
      lines.push(`      Authorization: ${JSON.stringify(server.headers.Authorization)}`);
      lines.push("    enabled: true");
      lines.push("    skip_preflight: true");
      lines.push("    tools:");
      lines.push("      resources: false");
      lines.push("      prompts: false");
      lines.push("      include:");
      for (const tool of server.tools.include) {
        lines.push(`        - ${JSON.stringify(tool)}`);
      }
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Serializes environment variables into `.env` format.
 */
export function serializeHermesDotenv(envVars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(envVars)) {
    // Quote with JSON.stringify for safe dotenv parsing
    lines.push(`${key}=${JSON.stringify(val)}`);
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/**
 * Cleans up stale ephemeral Paperclip run profiles under `<hostHermesHome>/profiles`.
 * Scoped safely strictly to directories starting with `paperclip-run-`.
 */
export async function cleanupStaleHermesProfiles(
  profilesDir: string,
  maxAgeMs = 24 * 3600_000,
  onWarning?: (msg: string) => void,
): Promise<void> {
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("paperclip-run-")) {
        continue;
      }
      const dirPath = path.join(profilesDir, entry.name);
      try {
        const stat = await fs.stat(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(dirPath, { recursive: true, force: true });
        }
      } catch {
        // Non-fatal per-directory cleanup
      }
    }
  } catch {
    if (onWarning) {
      onWarning("Stale profile directory cleanup warning");
    }
  }
}

/**
 * Recursively copies skills from host skills directory into the isolated HERMES_HOME.
 * - Does not follow unsafe external symlinks; skips/rejects any symlink that resolves
 *   outside of the canonical source root.
 * - Uses recursion-stack cycle detection (per-branch ancestor tracking) to prevent infinite loops
 *   along recursion cycles.
 * - Uses a canonical-realpath-to-first-destination map to cache traversed directories:
 *   when a canonical source directory was already traversed, subsequent occurrences receive
 *   the complete cached isolated snapshot contents with restrictive perms (0o700 dirs, 0o600 files)
 *   and no symlinks.
 * - Source traversal is bounded to O(nodes), while all destinations remain complete regardless
 *   of traversal order (symlink alias before real path, real path before symlink alias, or diamond DAGs).
 * - Separates source reads from destination writes: source realpath/stat/readdir/readFile
 *   EACCES/EPERM/EIO/ENOENT warn and skip the optional entry; destination mkdir/write/copy/chmod
 *   failures always throw fail-closed.
 * - Host skills are optional: top-level read errors warn and continue without skills.
 * - Preserves only regular files (0o600) and directories (0o700) in the destination.
 * - Ensures Hermes runtime execution cannot write through to host ~/.hermes/skills.
 */
export async function copyIsolatedSkills(
  sourceDir: string,
  destDir: string,
  onWarning?: (msg: string) => void,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(sourceDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    if (code === "EACCES" || code === "EPERM" || code === "EIO") {
      onWarning?.(redactDiagnosticText(`Failed to stat skills directory "${sourceDir}": ${(err as Error).message}`));
      return;
    }
    throw err;
  }
  if (!stat.isDirectory()) return;

  let canonicalSourceRoot: string;
  try {
    canonicalSourceRoot = await fs.realpath(sourceDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    if (code === "EACCES" || code === "EPERM" || code === "EIO") {
      onWarning?.(redactDiagnosticText(`Failed to resolve skills directory "${sourceDir}": ${(err as Error).message}`));
      return;
    }
    throw err;
  }

  // Destination directory creation - fail-closed on destination security/write failure
  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  await fs.chmod(destDir, 0o700);

  interface CanonicalSnapshot {
    destDir: string;
    hasSkippedEntries: boolean;
  }
  const canonicalDestMap = new Map<string, CanonicalSnapshot>();

  async function copyIsolatedSnapshot(srcSnapshotDir: string, targetDestDir: string): Promise<void> {
    await fs.mkdir(targetDestDir, { recursive: true, mode: 0o700 });
    await fs.chmod(targetDestDir, 0o700);

    const entries = await fs.readdir(srcSnapshotDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcSnapshotDir, entry.name);
      const destPath = path.join(targetDestDir, entry.name);
      if (entry.isDirectory()) {
        await copyIsolatedSnapshot(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
        await fs.chmod(destPath, 0o600);
      }
    }
  }

  async function copyDir(
    currentSrc: string,
    currentDest: string,
    activeAncestors: Set<string>,
    displayPath?: string,
  ): Promise<boolean> {
    const reportPath = displayPath ?? currentSrc;
    let realCurrentSrc: string;
    try {
      realCurrentSrc = await fs.realpath(currentSrc);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return true;
      }
      if (code === "EACCES" || code === "EPERM" || code === "EIO") {
        onWarning?.(redactDiagnosticText(`Failed to resolve directory "${reportPath}": ${(err as Error).message}`));
        return true;
      }
      throw err;
    }

    if (activeAncestors.has(realCurrentSrc)) {
      onWarning?.(
        redactDiagnosticText(
          `Detected symlink cycle involving directory "${reportPath}"; terminating cycle traversal.`,
        ),
      );
      return true;
    }

    const cached = canonicalDestMap.get(realCurrentSrc);
    if (cached) {
      if (cached.hasSkippedEntries) {
        onWarning?.(
          redactDiagnosticText(
            `Skill snapshot for "${reportPath}" is incomplete because some source entries were skipped during initial traversal.`,
          ),
        );
      }
      await copyIsolatedSnapshot(cached.destDir, currentDest);
      return cached.hasSkippedEntries;
    }

    // Destination directory creation - fail-closed
    await fs.mkdir(currentDest, { recursive: true, mode: 0o700 });
    await fs.chmod(currentDest, 0o700);

    const branchAncestors = new Set(activeAncestors);
    branchAncestors.add(realCurrentSrc);

    let entries;
    try {
      entries = await fs.readdir(currentSrc, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return true;
      }
      if (code === "EACCES" || code === "EPERM" || code === "EIO") {
        onWarning?.(redactDiagnosticText(`Failed to read directory "${reportPath}": ${(err as Error).message}`));
        return true;
      }
      throw err;
    }

    let hasSkippedEntries = false;

    for (const entry of entries) {
      const srcPath = path.join(currentSrc, entry.name);
      const destPath = path.join(currentDest, entry.name);

      if (entry.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = await fs.realpath(srcPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            // Broken symlink; skip safely without failing
            hasSkippedEntries = true;
            continue;
          }
          if (code === "EACCES" || code === "EPERM" || code === "EIO") {
            onWarning?.(redactDiagnosticText(`Failed to resolve symlink "${srcPath}": ${(err as Error).message}`));
            hasSkippedEntries = true;
            continue;
          }
          throw err;
        }

        // Reject/skip symlinks that escape source root
        if (!realTarget.startsWith(canonicalSourceRoot + path.sep) && realTarget !== canonicalSourceRoot) {
          hasSkippedEntries = true;
          continue;
        }

        let targetStat;
        try {
          targetStat = await fs.stat(realTarget);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            hasSkippedEntries = true;
            continue;
          }
          if (code === "EACCES" || code === "EPERM" || code === "EIO") {
            onWarning?.(redactDiagnosticText(`Failed to stat symlink target "${realTarget}": ${(err as Error).message}`));
            hasSkippedEntries = true;
            continue;
          }
          throw err;
        }

        if (targetStat.isDirectory()) {
          const childSkipped = await copyDir(realTarget, destPath, branchAncestors, srcPath);
          if (childSkipped) {
            hasSkippedEntries = true;
          }
        } else if (targetStat.isFile()) {
          let content: Buffer;
          try {
            content = await fs.readFile(realTarget);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EIO") {
              onWarning?.(redactDiagnosticText(`Failed to read source file "${realTarget}": ${(err as Error).message}`));
              hasSkippedEntries = true;
              continue;
            }
            throw err;
          }
          // Destination operations throw fail-closed on destination failure
          await fs.writeFile(destPath, content, { mode: 0o600 });
          await fs.chmod(destPath, 0o600);
        } else {
          hasSkippedEntries = true;
        }
      } else if (entry.isDirectory()) {
        const childSkipped = await copyDir(srcPath, destPath, branchAncestors);
        if (childSkipped) {
          hasSkippedEntries = true;
        }
      } else if (entry.isFile()) {
        let content: Buffer;
        try {
          content = await fs.readFile(srcPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EIO") {
            onWarning?.(redactDiagnosticText(`Failed to read source file "${srcPath}": ${(err as Error).message}`));
            hasSkippedEntries = true;
            continue;
          }
          throw err;
        }
        // Destination operations throw fail-closed on destination failure
        await fs.writeFile(destPath, content, { mode: 0o600 });
        await fs.chmod(destPath, 0o600);
      } else {
        hasSkippedEntries = true;
      }
    }

    canonicalDestMap.set(realCurrentSrc, {
      destDir: currentDest,
      hasSkippedEntries,
    });
    return hasSkippedEntries;
  }

  await copyDir(canonicalSourceRoot, destDir, new Set<string>());
}

/**
 * Prepares an isolated HERMES_HOME temporary directory for a run with runtime MCP servers.
 *
 * Security & Isolation invariants:
 * - Temporary profile created under `<hostHermesHome>/profiles/` with permissions 0700.
 *   This ensures Hermes's built-in global auth fallback resolves `<hostHermesHome>/auth.json`
 *   as read-only, while all runtime writes remain confined to the ephemeral profile.
 * - Host auth.json is NEVER symlinked or written through.
 * - config.yaml and .env written with permissions 0600.
 * - Host config posture (model/provider/guardrails) is inherited through a strict closed allowlist;
 *   host mcp_servers, memory, state, database, and telemetry are strictly excluded.
 * - Runtime MCP server definitions emit `resources: false` and `prompts: false`.
 * - Raw MCP tokens are placed in temp .env (mode 0600) and referenced via ${ENV_VAR}.
 * - Host provider credentials from .env are filtered by closed allowlist and returned for child process
 *   env injection only, never copied to temp .env or logged.
 * - Host skills are copied into an isolated snapshot (no write-through to host ~/.hermes/skills).
 */
export async function prepareHermesMcpHome(
  options: PrepareHermesMcpHomeOptions,
): Promise<PreparedHermesMcpHome> {
  const { config, memory } = options;
  const servers = options.servers ?? [];
  const isolatedFromHost = options.isolatedFromHost === true;
  // A Ramp Router run always gets its own profile, even with no MCP servers or memory.
  const routerProfile = options.canonicalRouterEndpoint === true;
  if (servers.length === 0 && !memory && !options.memoryProvider && !isolatedFromHost && !routerProfile) {
    throw new Error("Cannot prepare Hermes isolated home: no servers or memory provided");
  }
  if (routerProfile && !options.tempDirPrefix) {
    // Router profiles live in the per-run home, never in the host Hermes profiles tree.
    throw new Error("Cannot prepare a Ramp Router Hermes profile without a run home directory");
  }
  if (isolatedFromHost && !options.tempDirPrefix) {
    throw new Error("Cannot prepare isolated Hermes home without a run home directory");
  }

  // Validate all servers before creating temp directory
  for (const server of servers) {
    validateMcpServer(server);
  }

  const hostHermesDir = isolatedFromHost ? null : resolveHostHermesDir(config);
  let homeDir: string;

  if (options.tempDirPrefix) {
    homeDir = await fs.mkdtemp(options.tempDirPrefix);
  } else {
    if (hostHermesDir === null) {
      // Unreachable: isolated mode requires tempDirPrefix. Never create a profile dir relative to cwd.
      throw new Error("Cannot prepare isolated Hermes home without a run home directory");
    }
    const profilesDir = path.join(hostHermesDir, "profiles");
    try {
      await fs.mkdir(profilesDir, { recursive: true, mode: 0o700 });
      try {
        await fs.chmod(profilesDir, 0o700);
      } catch {
        if (options.onWarning) {
          options.onWarning("Failed to tighten permissions on Hermes profiles directory");
        }
      }
    } catch {
      throw new Error("Cannot create Hermes profiles directory for isolated execution");
    }

    // Clean up stale orphaned paperclip-run-* profile directories older than 24 hours.
    // Run tokens have a TTL of 1 hour, so any run profile older than 24 hours is
    // definitively dead/orphaned from an ungraceful crash or process termination.
    // Active runs are never impacted. Normal runs are cleaned up by finally blocks.
    await cleanupStaleHermesProfiles(profilesDir, 24 * 3600_000, options.onWarning);

    try {
      homeDir = await fs.mkdtemp(path.join(profilesDir, "paperclip-run-"));
    } catch {
      throw new Error("Cannot create temporary profile directory in Hermes profiles directory");
    }
  }

  try {
    await fs.chmod(homeDir, 0o700);
    const usedServerKeys = new Set<string>();
    const usedEnvVars = new Set<string>();
    const mcpServers: Record<string, HermesMcpServerConfig> = {};
    const envRecord: Record<string, string> = {};
    const serverKeys: string[] = [];

    for (const server of servers) {
      const serverKey = sanitizeServerKey(server.name, server.connectionId, usedServerKeys);
      serverKeys.push(serverKey);
      const envVar = sanitizeEnvVarName(serverKey, usedEnvVars);

      // Deduplicate tools preserving order
      const tools = Array.from(new Set(server.allowedTools));

      mcpServers[serverKey] = {
        url: options.bridgeRelay ? `\${PAPERCLIP_API_URL}${hermesMcpRelayPath(serverKey)}` : server.url,
        headers: {
          Authorization: options.bridgeRelay ? "Bearer ${PAPERCLIP_API_KEY}" : `Bearer \${${envVar}}`,
        },
        enabled: true,
        skip_preflight: true,
        tools: {
          resources: false,
          prompts: false,
          include: tools,
        },
      };
      if (!options.bridgeRelay) envRecord[envVar] = server.token;
    }

    // 1. Inherit sanitized host config posture
    let inheritedHostYaml = "";
    if (hostHermesDir !== null) {
      try {
        const hostConfigPath = path.join(hostHermesDir, "config.yaml");
        const hostConfigContent = await fs.readFile(hostConfigPath, "utf8");
        inheritedHostYaml = sanitizeHostConfigYaml(hostConfigContent, options.onWarning, {
          canonicalRouterEndpoint: options.canonicalRouterEndpoint === true,
        });
      } catch (err) {
        // Keep ENOENT silent (host config is optional); emit redacted warning on other read errors
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          options.onWarning?.("Failed to read host configuration file");
        }
      }
    }

    // 2. Inherit provider secrets from host .env (filtered by closed allowlist)
    let providerEnv: Record<string, string> = {};
    if (hostHermesDir !== null) {
      try {
        const hostEnvPath = path.join(hostHermesDir, ".env");
        const hostEnvContent = await fs.readFile(hostEnvPath, "utf8");
        providerEnv = filterProviderEnv(hostEnvContent, options.onWarning);
      } catch (err) {
        // Keep ENOENT silent (host .env is optional); emit redacted warning on other read errors
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          options.onWarning?.("Failed to read host environment file");
        }
      }
    }

    const hardeningFlags = options.flags ?? resolveEffectiveMemoryHardeningFlags(
      process.env,
      (options.config?.env as Record<string, string | undefined>) ?? undefined,
    );

    const configPath = path.join(homeDir, "config.yaml");
    const envPath = path.join(homeDir, ".env");
    let mem0JsonPath: string | undefined;

    if (memory) {
      mem0JsonPath = path.join(homeDir, "mem0.json");
      const mem0Content = serializeMem0Json(memory, hardeningFlags);
      await fs.writeFile(mem0JsonPath, mem0Content, { mode: 0o600 });
      // Explicit hard fail on mem0.json chmod; failures abort and trigger cleanup in catch
      await fs.chmod(mem0JsonPath, 0o600);
    }

    const yamlContent = serializeHermesMcpYaml(
      mcpServers, inheritedHostYaml, Boolean(memory) || options.memoryProvider === "mem0", hardeningFlags, options.anthropicRequestTimeoutSec,
    );
    await fs.writeFile(configPath, yamlContent, { mode: 0o600 });
    // Explicit hard fail on configPath chmod; failures abort and trigger cleanup in catch
    await fs.chmod(configPath, 0o600);

    // Temp .env contains strictly run MCP tokens, never host provider secrets
    await fs.writeFile(envPath, serializeHermesDotenv(envRecord), { mode: 0o600 });
    // Explicit hard fail on envPath chmod; failures abort and trigger cleanup in catch
    await fs.chmod(envPath, 0o600);

    // Copy host skills if present into isolated snapshot
    if (hostHermesDir !== null) {
      const hostSkillsDir = resolveHostHermesSkillsDir(config);
      await copyIsolatedSkills(hostSkillsDir, path.join(homeDir, "skills"), options.onWarning);
    }

    return {
      homeDir,
      configPath,
      envPath,
      mem0JsonPath,
      env: envRecord,
      providerEnv,
      serverCount: servers.length,
      serverKeys,
      hasMemory: Boolean(memory),
    };
  } catch (error) {
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Removes the isolated HERMES_HOME temporary directory.
 */
export async function cleanupHermesMcpHome(
  homeDir: string | null | undefined,
  onWarning?: (msg: string) => void,
): Promise<void> {
  if (!homeDir) return;
  try {
    await fs.rm(homeDir, { recursive: true, force: true });
  } catch {
    if (onWarning) {
      onWarning("Temporary Hermes home cleanup encountered an error");
    }
  }
}
