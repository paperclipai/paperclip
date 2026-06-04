/**
 * Per-instance managed home + per-turn host_config.json writer + skills
 * directory for amplifier-local.
 *
 * Mirrors the codex-home.ts pattern from codex-local: each (instance,
 * company) gets a stable managed directory under the Paperclip instance
 * root, and per-turn artefacts (host_config.json, skills/) are written
 * atomically inside it.
 *
 * Why managed-dir-per-company:
 *   - Same isolation guarantee as codex-local's CODEX_HOME isolation
 *   - Skills symlinks survive across turns (don't leak between companies)
 *   - host_config.json is rewritten per turn but kept at a stable path so a
 *     resumed session sees a fresh config
 *
 * MCP server config is NOT handled here — the amplifier-agent-ts wrapper
 * (≥0.6.1) owns the MCP spill via its `resolveMcpConfigPath` / `cleanupSpillFile`
 * helpers. The adapter passes `mcpServers` directly to `spawnAgent({ mcpServers })`
 * and the wrapper writes a 0600 tmpfile under `$XDG_RUNTIME_DIR/amplifier-agent/<sessionId>/`
 * and injects `AMPLIFIER_MCP_CONFIG` into the subprocess env.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the per-company managed root for amplifier-local artefacts:
 *
 *   $PAPERCLIP_HOME/instances/<instanceId>/companies/<companyId>/amplifier-local/
 *
 * `resolvePaperclipInstanceRootForAdapter` falls back to
 * ~/.paperclip/instances/<id>/ when PAPERCLIP_HOME is not set.
 */
export function resolveAmplifierLocalManagedDir(
  env: NodeJS.ProcessEnv = process.env,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "amplifier-local")
    : path.resolve(instanceRoot, "amplifier-local");
}

/**
 * The host_config.json path within the managed dir. Stable across turns so
 * resumed sessions re-read the same file.
 */
export function resolveHostConfigPath(managedDir: string): string {
  return path.join(managedDir, "host_config.json");
}

/**
 * The skills directory the engine's tool-skills module will scan. Symlinks
 * to paperclip skills are placed here, then surfaced to the engine via
 * `host_config.skills.skills = [<skillsDir>]`.
 */
export function resolveSkillsDir(managedDir: string): string {
  return path.join(managedDir, "skills");
}

// ---------------------------------------------------------------------------
// host_config.json types and writer
// ---------------------------------------------------------------------------

/**
 * Shape of host_config.json that amplifier-agent's loader accepts.
 * The loader closes the top-level schema to these five keys (anything else
 * raises `config_unknown_key` at parse time):
 *   - mcp:        passes through to tool-mcp module config (rarely set by
 *                 this adapter — wrapper handles MCP via env var)
 *   - approval:   mode in {"yes","no","prompt"} + optional patterns[]
 *   - provider:   module + config (config overlays onto provider module's
 *                 mount config — `model` goes here)
 *   - allowProtocolSkew: bypasses protocol version check (UNSAFE)
 *   - skills:    skills[] (list-concatenated with bundle defaults) +
 *                visibility{} (dict-overlay onto bundle defaults)
 */
export interface AmplifierAgentHostConfig {
  approval?: {
    mode?: "yes" | "no" | "prompt";
    patterns?: string[];
  };
  provider?: {
    module?: string;
    config?: Record<string, unknown>;
  };
  mcp?: {
    configPath?: string;
    [k: string]: unknown;
  };
  allowProtocolSkew?: boolean;
  skills?: {
    skills?: string[];
    visibility?: Record<string, unknown>;
  };
}

/**
 * Atomically write host_config.json (write-to-tmp then rename) so a partially
 * written file is never observed by a concurrent engine read on session
 * resume.
 */
export async function writeHostConfigAtomic(
  hostConfigPath: string,
  config: AmplifierAgentHostConfig,
): Promise<void> {
  const dir = path.dirname(hostConfigPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${hostConfigPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, hostConfigPath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
