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
import { guildSkillCreateSchema } from "@paperclipai/shared";

import { guildSkillService } from "../services/guild-skills.js";
import { GUILD_WORKER_LEARNINGS_FILE } from "./guild-worker-env.js";

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
}

export interface RejectedSkill {
  name: string | null;
  reason: string;
}

export interface IngestGuildLearningsResult {
  /** Skills successfully persisted (in insertion order). */
  ingested: IngestedSkill[];
  /** Per-skill rejections with a short reason string (kept for
   * logging + persisting on resultJson). */
  rejected: RejectedSkill[];
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
      fileMissing: false,
      topLevelError:
        "learnings.json must be an object with a `skills` array (top-level shape mismatch)",
    };
  }

  const candidates = (parsed as { skills: unknown[] }).skills;
  const svc = guildSkillService(input.db);
  const ingested: IngestedSkill[] = [];
  const rejected: RejectedSkill[] = [];

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
      ingested.push({ id: created.id, name: created.name });
    } catch (err) {
      rejected.push({
        name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ingested,
    rejected,
    fileMissing: false,
    topLevelError: null,
  };
}
