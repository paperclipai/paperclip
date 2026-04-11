export interface ActiveRunGuardOptions {
  fetchActiveRunCount: () => Promise<number>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

export interface ActiveRunGuardResult {
  waited: boolean;
  timedOut: boolean;
  finalRunCount: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export async function waitForActiveRunsToClear(
  options: ActiveRunGuardOptions,
): Promise<ActiveRunGuardResult> {
  const {
    fetchActiveRunCount,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    log = console.log,
  } = options;

  let runCount: number;
  try {
    runCount = await fetchActiveRunCount();
  } catch {
    return { waited: false, timedOut: false, finalRunCount: 0 };
  }

  if (runCount === 0) {
    return { waited: false, timedOut: false, finalRunCount: 0 };
  }

  log(
    `[paperclip] Restart queued — waiting for ${runCount} active run${runCount === 1 ? "" : "s"} to complete (timeout: ${Math.round(timeoutMs / 1000)}s)`,
  );

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      runCount = await fetchActiveRunCount();
    } catch {
      runCount = 0;
    }

    if (runCount === 0) {
      log("[paperclip] Active runs completed — proceeding with restart");
      return { waited: true, timedOut: false, finalRunCount: 0 };
    }
  }

  log(
    `[paperclip] Timeout reached (${Math.round(timeoutMs / 1000)}s) — proceeding with restart despite ${runCount} active run${runCount === 1 ? "" : "s"}`,
  );
  return { waited: true, timedOut: true, finalRunCount: runCount };
}
