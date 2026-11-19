import fs from "node:fs/promises";
import path from "node:path";

import { removeAbandonedSkillStaging } from "../../vendor/paperclip-runner/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SkillStagingSweepResult = { removed: number; candidates: number; bytes: number };

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
}): Promise<SkillStagingSweepResult> {
  const result: SkillStagingSweepResult = { removed: 0, candidates: 0, bytes: 0 };
  for (const sessionRoot of input.sessionRoots) {
    for (const session of await directories(sessionRoot)) {
      for (const home of await directories(session)) {
        const swept = await removeAbandonedSkillStaging(home, {
          olderThanMs: input.olderThanMs ?? DAY_MS, now: input.now, dryRun: input.dryRun,
        });
        result.removed += swept.removed;
        result.candidates += swept.candidates;
        result.bytes += swept.bytes;
      }
    }
  }
  return result;
}
