/** Require two fresh authenticated barriers before rotating a warm run authority. */
export async function waitForWarmAttachmentReadiness(input: {
  graceMs: number;
  waitForConnection: (deadline: number) => Promise<void>;
  snapshot: (deadline: number) => Promise<Record<string, unknown>>;
  onBlocked?: (blockers: unknown) => void;
}): Promise<void> {
  const deadline = Date.now() + input.graceMs;
  let consecutiveReadyProbes = 0;
  let lastBlockers: unknown = null;
  let probes = 0;
  // Each probe is a durable command. A 25 ms loop over the remote 120 second
  // reconnect budget can exhaust its 500-command journal before that budget.
  // Leave room for both ready-confirmation probes and ordinary commands. The
  // interval is proportional to the deadline, so a short local deadline never
  // inherits a one-second delay after a transient readiness regression.
  const blockedDelayMs = Math.max(25, Math.ceil(input.graceMs / 160));
  while (Date.now() < deadline) {
    await input.waitForConnection(deadline);
    const snapshot = await input.snapshot(deadline);
    probes += 1;
    if (snapshot.warmAttachReady !== true && JSON.stringify(snapshot.warmAttachBlockers) !== JSON.stringify(lastBlockers)) {
      input.onBlocked?.(snapshot.warmAttachBlockers);
    }
    lastBlockers = snapshot.warmAttachBlockers;
    if (snapshot.warmAttachReady === true) {
      consecutiveReadyProbes += 1;
      if (consecutiveReadyProbes >= 2) return;
    } else {
      consecutiveReadyProbes = 0;
    }
    const delayMs = snapshot.warmAttachReady === true || probes < 8 ? 25 : blockedDelayMs;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`native_runner_warm_attachment_not_quiescent: ${JSON.stringify(lastBlockers)}`);
}
