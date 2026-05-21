/**
 * Plan 3 Phase E1a — guild worker env shape.
 *
 * Builds the env-var map that the dispatcher layers on top of the
 * persisted `agent.adapterConfig.env` for runs whose agent has
 * `kind === 'guild'`. The Plan 2 routing wrap (heartbeat.ts) composes
 * this with the routing override env so the final env passed to
 * `adapter.execute` has, in priority order:
 *
 *   1. Routing override (HERMES_MODEL_OVERRIDE, HERMES_PROVIDER_OVERRIDE)
 *   2. Guild worker env (this module)
 *   3. Persisted agent env (PAPERCLIP_API_KEY, HERMES_YOLO_MODE, etc.)
 *
 * The keys this module emits never collide with the routing override
 * keys; routing override is authoritative for HERMES_* and the worker
 * env is authoritative for GUILD_* / WORKER_* / MEMORY_SERVICE_PROJECT.
 *
 * Workers read these vars at start of run to locate their sidecar files
 * (autonomy.json, available_skills.json), to know where to write their
 * `learnings.json` for the worker-exit hook to ingest, and to scope
 * memory-service observations to this guild's project namespace.
 *
 * For a non-guild agent the helper returns an empty object so the same
 * call site is safe to use unconditionally.
 *
 * See docs/superpowers/specs/2026-05-21-plan3-phase-e-worker-lifecycle.md
 * decisions D4, D7, D8.
 */
import path from "node:path";

import { agents } from "@paperclipai/db";

type AgentRow = typeof agents.$inferSelect;

export const GUILD_WORKER_LEARNINGS_FILE = "learnings.json";
export const GUILD_WORKER_SKILLS_FILE = "available_skills.json";
export const GUILD_WORKER_AUTONOMY_FILE = "autonomy.json";

/** memory-service project namespace prefix for per-guild observations.
 * Convention from spec D7: `farm/<guild-slug>`. */
export const GUILD_MEMORY_PROJECT_PREFIX = "farm";

export interface BuildGuildWorkerEnvInput {
  agent: Pick<AgentRow, "id" | "name" | "kind">;
  sandboxDir: string;
}

/**
 * Returns the env-var map for a guild worker spawn. For non-guild
 * agents returns {} so callers can spread unconditionally.
 */
export function buildGuildWorkerEnv(
  input: BuildGuildWorkerEnvInput,
): Record<string, string> {
  if (input.agent.kind !== "guild") return {};
  const { agent, sandboxDir } = input;
  return {
    GUILD_ID: agent.id,
    GUILD_SLUG: agent.name,
    GUILD_AUTONOMY_JSON_PATH: path.join(sandboxDir, GUILD_WORKER_AUTONOMY_FILE),
    GUILD_SKILLS_PATH: path.join(sandboxDir, GUILD_WORKER_SKILLS_FILE),
    WORKER_LEARNINGS_PATH: path.join(sandboxDir, GUILD_WORKER_LEARNINGS_FILE),
    MEMORY_SERVICE_PROJECT: `${GUILD_MEMORY_PROJECT_PREFIX}/${agent.name}`,
  };
}
