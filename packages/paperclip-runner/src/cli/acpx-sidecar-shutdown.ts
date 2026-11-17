import { createHash } from "node:crypto";

const MAX_SHUTDOWN_TOOL_SAMPLES = 16;

export function sidecarShutdownSnapshot(
  reason: string,
  tools: ReadonlyMap<string, { startedAt: number }>,
  pendingInputs: number,
  pendingPermissions: number,
  normalizingTools: number,
  now = performance.now(),
) {
  const samples = [...tools]
    .sort((left, right) => left[1].startedAt - right[1].startedAt)
    .slice(0, MAX_SHUTDOWN_TOOL_SAMPLES)
    .map(([callId, pending]) => ({
      callIdSha256: createHash("sha256").update(callId).digest("hex"),
      elapsedMs: Math.max(0, Math.floor(now - pending.startedAt)),
    }));
  return {
    reason,
    pendingTools: tools.size,
    pendingInputs,
    pendingPermissions,
    normalizingTools,
    tools: samples,
    truncatedTools: tools.size - samples.length,
  };
}

export function recordSidecarShutdownThenQueue(record: () => void, queueShutdown: () => void): boolean {
  let recorded = true;
  try {
    record();
  } catch {
    recorded = false;
  }
  queueShutdown();
  return recorded;
}
