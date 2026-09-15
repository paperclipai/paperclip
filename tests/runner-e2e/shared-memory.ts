import { execFileSync } from "node:child_process";
import os from "node:os";

export interface DarwinSharedMemorySegment {
  id: string;
  owner: string;
  attachments: number;
  creatorPid: number;
}

export function parseDarwinSharedMemory(
  output: string,
): DarwinSharedMemorySegment[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "m" || fields.length < 11) return [];
    const attachments = Number(fields[8]);
    const creatorPid = Number(fields[10]);
    if (!Number.isInteger(attachments) || !Number.isInteger(creatorPid))
      return [];
    return [
      {
        id: fields[1]!,
        owner: fields[4]!,
        attachments,
        creatorPid,
      },
    ];
  });
}

export function snapshotDarwinSharedMemory(): ReadonlySet<string> {
  if (process.platform !== "darwin") return new Set();
  try {
    return new Set(
      parseDarwinSharedMemory(
        execFileSync("ipcs", ["-m", "-a"], { encoding: "utf8" }),
      ).map((segment) => segment.id),
    );
  } catch {
    return new Set();
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

/**
 * Embedded PostgreSQL can leave one 56-byte SysV segment on macOS when its
 * supervising process tree is terminated. macOS defaults to only 32 segment
 * IDs, so serial isolated cells eventually cannot run initdb. Reap only a
 * segment that appeared during this attempt, belongs to this OS user, has no
 * attachments, and whose creator has exited.
 */
export function reapNewDetachedDarwinSharedMemory(
  baseline: ReadonlySet<string>,
): string[] {
  if (process.platform !== "darwin") return [];
  let current: DarwinSharedMemorySegment[];
  try {
    current = parseDarwinSharedMemory(
      execFileSync("ipcs", ["-m", "-a"], { encoding: "utf8" }),
    );
  } catch {
    return [];
  }
  const owner = os.userInfo().username;
  const removed: string[] = [];
  for (const segment of current) {
    if (
      baseline.has(segment.id) ||
      segment.owner !== owner ||
      segment.attachments !== 0 ||
      processIsAlive(segment.creatorPid)
    ) {
      continue;
    }
    try {
      execFileSync("ipcrm", ["-m", segment.id], { stdio: "ignore" });
      removed.push(segment.id);
    } catch {
      // Cleanup verification still catches a resulting bootstrap failure.
    }
  }
  return removed;
}
