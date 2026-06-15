export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

export function outputSilenceAgeMs(
  run: {
    lastOutputAt: Date | null;
    processStartedAt: Date | null;
    startedAt: Date | null;
    createdAt: Date | null;
  },
  now: Date,
) {
  const reference =
    run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  return reference ? Math.max(0, now.getTime() - reference.getTime()) : null;
}
