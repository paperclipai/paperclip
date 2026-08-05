import fs from "node:fs/promises";

export type LocalProcessIdentity = {
  pid: number;
  startTicks: number;
  runId: string;
};

export async function readLocalProcessIdentity(pid: number): Promise<LocalProcessIdentity | null> {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const [stat, environ] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile(`/proc/${pid}/environ`, "utf8"),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = Number(fieldsAfterCommand[19]);
    if (!Number.isSafeInteger(startTicks) || startTicks < 0) return null;
    const runEntry = environ.split("\0").find((entry) => entry.startsWith("PAPERCLIP_RUN_ID="));
    const runId = runEntry?.slice("PAPERCLIP_RUN_ID=".length).trim();
    if (!runId) return null;
    return { pid, startTicks, runId };
  } catch {
    return null;
  }
}

export async function matchesLocalProcessIdentity(input: {
  pid: number;
  startTicks: number;
  runId: string;
}) {
  const current = await readLocalProcessIdentity(input.pid);
  return Boolean(
    current &&
    current.startTicks === input.startTicks &&
    current.runId === input.runId,
  );
}
