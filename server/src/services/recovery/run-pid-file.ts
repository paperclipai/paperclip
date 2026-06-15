import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type RunPidFileRecord = {
  pid: number;
  runId: string;
  startedAt: string;
};

export function runPidFilePath(pidFileDir: string, runId: string) {
  return path.join(pidFileDir, `run-${runId}.pid`);
}

export async function writeRunPidFile(
  pidFileDir: string,
  runId: string,
  record: RunPidFileRecord,
) {
  await mkdir(pidFileDir, { recursive: true });
  const body = `${record.pid}\n${record.runId}\n${record.startedAt}\n`;
  await writeFile(runPidFilePath(pidFileDir, runId), body, "utf8");
}

export async function readRunPidFile(
  pidFileDir: string,
  runId: string,
): Promise<RunPidFileRecord | null> {
  try {
    const raw = await readFile(runPidFilePath(pidFileDir, runId), "utf8");
    const [pidLine, fileRunId, startedAt] = raw.split(/\r?\n/);
    const pid = Number(pidLine);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (fileRunId !== runId) return null;
    if (!startedAt?.trim()) return null;
    return { pid, runId, startedAt: startedAt.trim() };
  } catch {
    return null;
  }
}

export async function removeRunPidFile(pidFileDir: string, runId: string) {
  try {
    await rm(runPidFilePath(pidFileDir, runId), { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

export async function resolveRunChildPid(input: {
  pidFileDir: string;
  runId: string;
  processPid: number | null;
}) {
  if (typeof input.processPid === "number" && Number.isInteger(input.processPid) && input.processPid > 0) {
    return input.processPid;
  }
  const record = await readRunPidFile(input.pidFileDir, input.runId);
  return record?.pid ?? null;
}
