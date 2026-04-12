import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SysvSharedMemoryProcessRow = {
  id: string;
  owner: string;
  creatorPid: number;
  lastOperatorPid: number;
};

export function parseIpcsSharedMemoryProcessTable(output: string): SysvSharedMemoryProcessRow[] {
  const rows: SysvSharedMemoryProcessRow[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("IPC status") || line.startsWith("T ") || line === "Shared Memory:") {
      continue;
    }

    const columns = line.split(/\s+/);
    if (columns[0] === "m" && columns.length >= 8 && /^\d+$/.test(columns[1] ?? "")) {
      rows.push({
        id: columns[1]!,
        owner: columns[4]!,
        creatorPid: Number.parseInt(columns[6] ?? "0", 10) || 0,
        lastOperatorPid: Number.parseInt(columns[7] ?? "0", 10) || 0,
      });
      continue;
    }

    if (/^\d+$/.test(columns[0] ?? "") && columns.length >= 4) {
      rows.push({
        id: columns[0]!,
        owner: columns[1]!,
        creatorPid: Number.parseInt(columns[2] ?? "0", 10) || 0,
        lastOperatorPid: Number.parseInt(columns[3] ?? "0", 10) || 0,
      });
    }
  }

  return rows;
}

export function findOrphanedSysvSharedMemoryIds(
  rows: readonly SysvSharedMemoryProcessRow[],
  owner: string,
  isPidRunning: (pid: number) => boolean,
): string[] {
  const orphaned = new Set<string>();

  for (const row of rows) {
    if (row.owner !== owner) continue;

    const creatorAlive = row.creatorPid > 0 && isPidRunning(row.creatorPid);
    const lastOperatorAlive = row.lastOperatorPid > 0 && isPidRunning(row.lastOperatorPid);
    if (!creatorAlive && !lastOperatorAlive) {
      orphaned.add(row.id);
    }
  }

  return [...orphaned];
}

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function releaseOrphanedSysvSharedMemory(owner = process.env.USER ?? ""): Promise<string[]> {
  if (!owner || process.platform === "win32") return [];

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("ipcs", ["-m", "-p"]));
  } catch {
    return [];
  }

  const orphanedIds = findOrphanedSysvSharedMemoryIds(
    parseIpcsSharedMemoryProcessTable(stdout),
    owner,
    isPidRunning,
  );

  for (const shmid of orphanedIds) {
    try {
      await execFileAsync("ipcrm", ["-m", shmid]);
    } catch {
      // Best-effort cleanup; another process may have removed it already.
    }
  }

  return orphanedIds;
}
