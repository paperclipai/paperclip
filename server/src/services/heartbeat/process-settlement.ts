type LocalProcessIdentity = {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
};

/** The HTTP adapter awaits a remote response and never creates a host process. */
export function legacyAdapterNeedsLocalProcessSettlement(input: {
  adapterType: string;
  executionTargetKind?: "local" | "remote";
}): boolean {
  return input.adapterType !== "http" && input.executionTargetKind !== "remote";
}

/**
 * The adapter's main process closing does not prove its descendants stopped.
 * This is absence evidence only: persisted identifiers never authorize signals.
 * Call only for a known local target and its host-recorded process generation.
 */
export function hasStoppedLocalProcessTree(
  identity: LocalProcessIdentity,
  probe: (pid: number) => unknown = pid => process.kill(pid, 0),
): boolean {
  if (process.platform === "win32" ||
      !Number.isSafeInteger(identity.processPid) || (identity.processPid ?? 0) <= 1 ||
      !Number.isSafeInteger(identity.processGroupId) || (identity.processGroupId ?? 0) <= 1 ||
      !identity.processStartedAt || !Number.isFinite(identity.processStartedAt.getTime())) return false;
  const absent = (pid: number) => {
    try { probe(pid); return false; }
    catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "ESRCH"; }
  };
  return absent(identity.processPid!) && absent(-identity.processGroupId!);
}
