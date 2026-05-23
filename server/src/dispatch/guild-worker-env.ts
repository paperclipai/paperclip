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

/**
 * Phase 2 Task 2.1 -- video-guild dispatcher env-var pass-through.
 *
 * Issue titles of the form `video-<stage>/<request_id>` are emitted by
 * the video-ad orchestrator for each pipeline stage. When the
 * dispatcher spawns a worker for one of these issues we surface the
 * parent request id + stage as env vars so worker-side tools can scope
 * their reads/writes to the right ad campaign.
 *
 * Stages are exact: research, strategy, copy, edit. Anything else (e.g.
 * `video-foo/...`) is ignored so a typo never silently activates the
 * video-ad code path. The request_id segment must not contain a slash,
 * so titles like `video-research/campaign-42/v2` fail to match cleanly
 * rather than silently swallowing the extra path segment.
 */
const VIDEO_ISSUE_TITLE_PATTERN = /^video-(research|strategy|copy|edit)\/([^/]+)$/;

export interface BuildGuildWorkerEnvInput {
  agent: Pick<AgentRow, "id" | "name" | "kind">;
  sandboxDir: string;
  /**
   * Title of the issue the worker is being dispatched for, if any.
   * When the title matches `video-<stage>/<request_id>` the helper
   * additionally emits VIDEO_AD_STAGE + VIDEO_AD_REQUEST_ID.
   */
  issueTitle?: string | null;
}

/**
 * Returns the env-var map for a guild worker spawn. For non-guild
 * agents returns {} so callers can spread unconditionally.
 */
export function buildGuildWorkerEnv(
  input: BuildGuildWorkerEnvInput,
): Record<string, string> {
  if (input.agent.kind !== "guild") return {};
  const { agent, sandboxDir, issueTitle } = input;
  const env: Record<string, string> = {
    GUILD_ID: agent.id,
    GUILD_SLUG: agent.name,
    GUILD_AUTONOMY_JSON_PATH: path.join(sandboxDir, GUILD_WORKER_AUTONOMY_FILE),
    GUILD_SKILLS_PATH: path.join(sandboxDir, GUILD_WORKER_SKILLS_FILE),
    WORKER_LEARNINGS_PATH: path.join(sandboxDir, GUILD_WORKER_LEARNINGS_FILE),
    MEMORY_SERVICE_PROJECT: `${GUILD_MEMORY_PROJECT_PREFIX}/${agent.name}`,
  };
  if (typeof issueTitle === "string") {
    const match = issueTitle.match(VIDEO_ISSUE_TITLE_PATTERN);
    if (match) {
      env.VIDEO_AD_STAGE = match[1];
      env.VIDEO_AD_REQUEST_ID = match[2];
    }
  }
  return env;
}
