/**
 * Plan 3 Phase E2a — worker-exit learnings ingestion.
 *
 * After a guild run reaches terminal status, the dispatcher invokes
 * this helper to read the worker's `learnings.json` (if any) from the
 * per-run sandbox dir and persist each entry as a provisional skill
 * against the guild.
 *
 * The helper delegates the actual write to the existing
 * `guild-skills` service (`create`), which already:
 *   - validates name + body (length, kebab-case regex);
 *   - refuses cross-company / cross-guild writes;
 *   - forces `provenance='provisional'` (workers cannot mint canonical);
 *   - rejects duplicate names over non-retired rows.
 *
 * So the only logic in this module is: file-read, top-level shape
 * check, and a per-skill try/catch translating service errors into
 * structured `rejected[]` entries the caller can log.
 *
 * Per-skill failures are NEVER thrown — they end up in `rejected`.
 * Top-level failures (file unreadable, malformed JSON, bad shape) ARE
 * returned via the result; the caller chooses whether to log.warn,
 * mark resultJson, or surface to the operator.
 *
 * See docs/superpowers/specs/2026-05-21-plan3-phase-e-worker-lifecycle.md
 * decision D5, D13 (body shape guidance lives in AGENTS.md, not here).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Db } from "@paperclipai/db";
import type { agents as agentsTable } from "@paperclipai/db";
import { guildSkillCreateSchema, truncateGuildSkillBody } from "@paperclipai/shared";

import { guildSkillService } from "../services/guild-skills.js";
import { GUILD_WORKER_LEARNINGS_FILE } from "./guild-worker-env.js";

/**
 * Phase 2 Task 2.2 -- video.stage.completed activity_log emission.
 *
 * Pure parser: given a closing run's agent, issue title, and terminal
 * status, decide whether the dispatcher should emit a
 * `video.stage.completed` activity_log row. Returns `{stage, requestId}`
 * when the title matches `video-<stage>/<request_id>` AND the run
 * closed clean AND the agent is a guild; null otherwise.
 *
 * Mirrors the regex used in `buildGuildWorkerEnv` (`[^/]+` request_id
 * segment, exact stage list) so the entry and exit hooks agree on what
 * counts as a video-stage run. Defense-in-depth: rejects non-guild
 * agents even if a future caller forgot to gate, matching the same
 * pattern used elsewhere in this module.
 */
const VIDEO_ISSUE_TITLE_PATTERN = /^video-(research|strategy|copy|edit)\/([^/]+)$/;

export interface VideoStageCompletedEventInput {
  agent: Pick<AgentRow, "kind">;
  issueTitle?: string | null;
  /** Terminal run status as written by `setRunStatus`. Only
   * 'succeeded' (the heartbeat-run vocabulary for a clean exit) emits;
   * 'failed' / 'cancelled' / 'timed_out' / anything else suppresses.
   * The plan refers to this state as 'done'; the dispatcher uses
   * 'succeeded' for runs and reserves 'done' for the issue table. */
  runStatus: string;
}

export interface VideoStageCompletedEvent {
  stage: string;
  requestId: string;
}

export function parseVideoStageCompletedEvent(
  input: VideoStageCompletedEventInput,
): VideoStageCompletedEvent | null {
  if (input.agent.kind !== "guild") return null;
  if (input.runStatus !== "succeeded") return null;
  if (typeof input.issueTitle !== "string") return null;
  const match = input.issueTitle.match(VIDEO_ISSUE_TITLE_PATTERN);
  if (!match) return null;
  return { stage: match[1], requestId: match[2] };
}

type AgentRow = typeof agentsTable.$inferSelect;

export interface IngestGuildLearningsInput {
  db: Db;
  agent: Pick<AgentRow, "id" | "companyId" | "kind" | "name">;
  run: { id: string };
  sandboxDir: string;
}

export interface IngestedSkill {
  id: string;
  name: string;
  /**
   * Truncated preview of the skill body, capped at
   * GUILD_SKILL_BODY_PREVIEW_MAX codepoints with a trailing ellipsis
   * when the original was longer. Included so downstream consumers
   * (the ceo-chat Telegram notifier, the operator-facing activity_log
   * row) can render a preview line without re-fetching each skill.
   */
  body: string;
}

export interface RejectedSkill {
  name: string | null;
  reason: string;
}

/**
 * Plan 3b — record-use telemetry per entry in the worker's `used[]`
 * array. Reports back which canonical skill the worker actually
 * consulted and whether it helped. Powers downstream auto-promotion
 * heuristics (success_count / fail_count on the skills row).
 */
export interface RecordedUse {
  id: string;
  name: string;
  success: boolean;
}

export interface RejectedRecordedUse {
  /** May be null when the worker didn't supply a string id at all. */
  id: string | null;
  reason: string;
}

export interface IngestGuildLearningsResult {
  /** Skills successfully persisted (in insertion order). */
  ingested: IngestedSkill[];
  /** Per-skill rejections with a short reason string (kept for
   * logging + persisting on resultJson). */
  rejected: RejectedSkill[];
  /** Skills the worker reported using during the run, with success
   * outcomes recorded on the skills row (success_count++ on
   * success=true, fail_count++ on success=false). Plan 3b. */
  recordedUse: RecordedUse[];
  /** Per-use rejections (unknown id, malformed shape, cross-guild,
   * etc.). Same logging + resultJson treatment as `rejected`. */
  recordedUseRejected: RejectedRecordedUse[];
  /** True when the worker did not write `learnings.json`. Not a
   * failure: a worker that learned nothing skips the file by design. */
  fileMissing: boolean;
  /** Set when the top-level JSON shape was unparseable / not an
   * object with a `skills` array. The hook caller logs.warn and
   * persists this on resultJson so the operator can investigate. */
  topLevelError: string | null;
}

const EMPTY_RESULT: IngestGuildLearningsResult = {
  ingested: [],
  rejected: [],
  recordedUse: [],
  recordedUseRejected: [],
  fileMissing: true,
  topLevelError: null,
};

export async function ingestGuildLearnings(
  input: IngestGuildLearningsInput,
): Promise<IngestGuildLearningsResult> {
  // Defense in depth: callers should already gate on kind === 'guild',
  // but a defensive check here prevents a future caller from
  // accidentally minting provisional skills against a non-guild row.
  if (input.agent.kind !== "guild") return EMPTY_RESULT;

  const learningsPath = path.join(input.sandboxDir, GUILD_WORKER_LEARNINGS_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(learningsPath, "utf-8");
  } catch (err) {
    // ENOENT (worker wrote nothing) is the dominant non-error case;
    // other read failures are also surfaced as "fileMissing" because
    // we can't distinguish them from absent intent. The caller can
    // still inspect the warning via logger if it cares.
    return { ...EMPTY_RESULT, fileMissing: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ingested: [],
      rejected: [],
      recordedUse: [],
      recordedUseRejected: [],
      fileMissing: false,
      topLevelError: `learnings.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { skills?: unknown }).skills)
  ) {
    return {
      ingested: [],
      rejected: [],
      recordedUse: [],
      recordedUseRejected: [],
      fileMissing: false,
      topLevelError:
        "learnings.json must be an object with a `skills` array (top-level shape mismatch)",
    };
  }

  // Plan 3b: optional `used[]` array. Top-level shape check is lenient
  // — a non-array value is treated as if absent + a rejection note is
  // pushed below when iterating. Keeps the file-shape rules simple
  // (mandatory: `skills`; optional: `used`).
  const usedCandidatesRaw = (parsed as { used?: unknown }).used;
  const usedCandidates: unknown[] = Array.isArray(usedCandidatesRaw)
    ? usedCandidatesRaw
    : [];

  const candidates = (parsed as { skills: unknown[] }).skills;
  const svc = guildSkillService(input.db);
  const ingested: IngestedSkill[] = [];
  const rejected: RejectedSkill[] = [];
  const recordedUse: RecordedUse[] = [];
  const recordedUseRejected: RejectedRecordedUse[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate || typeof candidate !== "object") {
      rejected.push({
        name: null,
        reason: `entry at index ${i} is not an object`,
      });
      continue;
    }
    const obj = candidate as { name?: unknown; body?: unknown };
    const name = typeof obj.name === "string" ? obj.name : null;
    const body = typeof obj.body === "string" ? obj.body : null;
    if (!name || !body) {
      rejected.push({
        name,
        reason: `entry at index ${i} is missing 'name' or 'body' (or non-string)`,
      });
      continue;
    }
    // Re-run the same Zod schema the API route uses, so workers cannot
    // bypass body-length / kebab-case validation by writing directly
    // to learnings.json (the service layer doesn't re-validate).
    const validation = guildSkillCreateSchema.safeParse({
      name,
      body,
      createdByRunId: input.run.id,
    });
    if (!validation.success) {
      rejected.push({
        name,
        reason: validation.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
      continue;
    }
    try {
      const created = await svc.create(
        input.agent.companyId,
        input.agent.id,
        validation.data,
      );
      ingested.push({
        id: created.id,
        name: created.name,
        body: truncateGuildSkillBody(created.body),
      });
    } catch (err) {
      rejected.push({
        name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Plan 3b: process `used[]` entries. Each entry reports an outcome
  // on an existing canonical skill (the worker may also be allowed to
  // record use against a provisional skill — service-level decides;
  // currently `recordUse` allows any non-retired skill). The service
  // already enforces:
  //   - skill belongs to this guild + company (cross-tenant safety);
  //   - skill exists (404 → rejected here with the service error).
  // We pre-validate the shape (string id, boolean success) and surface
  // service errors as per-entry rejections, never throwing through.
  for (let i = 0; i < usedCandidates.length; i++) {
    const candidate = usedCandidates[i];
    if (!candidate || typeof candidate !== "object") {
      recordedUseRejected.push({
        id: null,
        reason: `used entry at index ${i} is not an object`,
      });
      continue;
    }
    const obj = candidate as { id?: unknown; success?: unknown };
    const id = typeof obj.id === "string" ? obj.id : null;
    const success = typeof obj.success === "boolean" ? obj.success : null;
    if (!id) {
      recordedUseRejected.push({
        id: null,
        reason: `used entry at index ${i} is missing 'id' (must be a string)`,
      });
      continue;
    }
    if (success === null) {
      recordedUseRejected.push({
        id,
        reason: `used entry at index ${i} is missing 'success' (must be a boolean)`,
      });
      continue;
    }
    try {
      const updated = await svc.recordUse(
        input.agent.companyId,
        input.agent.id,
        id,
        success,
        input.run.id,
      );
      recordedUse.push({
        id: updated.id,
        name: updated.name,
        success,
      });
    } catch (err) {
      recordedUseRejected.push({
        id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ingested,
    rejected,
    recordedUse,
    recordedUseRejected,
    fileMissing: false,
    topLevelError: null,
  };
}
