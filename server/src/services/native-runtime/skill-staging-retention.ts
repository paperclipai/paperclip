import fs from "node:fs/promises";
import path from "node:path";

import { removeAbandonedSkillStaging } from "../../vendor/paperclip-runner/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SkillStagingSweepResult = {
  removed: number;
  candidates: number;
  bytes: number;
  /** When the youngest kept staging becomes old enough to remove. */
  nextDueAt: number | null;
  /** Old staging was left because of the removal budget or a stop request. */
  truncated: boolean;
  /** Old staging that could not be removed safely (too large, or changed underneath). */
  skipped: number;
};

/** Provider homes the runner materializes skills into: `codex-home`, `claude-home`, `grok-home`, ... */
const PROVIDER_HOME_PATTERN = /^[a-z0-9]+-home$/;

async function directories(parent: string): Promise<string[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name));
}

/**
 * Removes skill staging that interrupted launches left in provider homes
 * (`<session root>/<session>/<home>/.paperclip-skills-staging-*`), such as
 * Codex `codex-home` and ACPX `claude-home`. A launch copies its skills in
 * minutes, so staging older than `olderThanMs` belongs to no live launch.
 */
export async function sweepAbandonedSkillStaging(input: {
  sessionRoots: string[];
  now: number;
  olderThanMs?: number;
  dryRun?: boolean;
  maxRemovals?: number;
  shouldContinue?: () => boolean;
}): Promise<SkillStagingSweepResult> {
  const result: SkillStagingSweepResult = { removed: 0, candidates: 0, bytes: 0, nextDueAt: null, truncated: false, skipped: 0 };
  const maxRemovals = input.maxRemovals ?? Infinity;
  for (const sessionRoot of input.sessionRoots) {
    for (const session of await directories(sessionRoot)) {
      for (const home of (await directories(session)).filter((home) => PROVIDER_HOME_PATTERN.test(path.basename(home)))) {
        const swept = await removeAbandonedSkillStaging(home, {
          olderThanMs: input.olderThanMs ?? DAY_MS, now: input.now, dryRun: input.dryRun,
          maxRemovals: maxRemovals - result.removed, shouldContinue: input.shouldContinue,
        });
        result.removed += swept.removed;
        result.candidates += swept.candidates;
        result.bytes += swept.bytes;
        result.truncated ||= swept.truncated;
        result.skipped += swept.skipped;
        if (swept.nextDueAt !== null) result.nextDueAt = Math.min(result.nextDueAt ?? swept.nextDueAt, swept.nextDueAt);
      }
    }
  }
  return result;
}
