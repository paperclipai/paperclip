// A wait against a real spawned OS process can run behind a far larger
// envelope than an in-process fake transport. Two waits in `src/live/**`
// use this helper and its deadline.
//
// The first wait (live-session.test.ts:1414, its wait at :1441) spawns the
// real `paperclip-runnerd` binary and a real Node child process for
// `test/fixtures/fake-durable-codex-app-server.mjs`, completes a transport
// handshake, runs one full turn that applies a governed effect, and writes
// and hashes a durable checkpoint to a temporary directory — all before the
// checkpoint first contains the applied effect. The enclosing test budgets
// 30 seconds for this (live-session.test.ts:1501-1502: "CI exercises two
// real process generations here and can exceed the unit default under
// load"). 20 uncontended samples of this path ranged from 163ms to 187ms
// (median 173ms). A deterministic 1,200ms SIGSTOP/SIGCONT stall of the real
// runnerd process reproduces a failure against vitest's default 1,000ms
// deadline and passes cleanly against the 10,000ms deadline below.
//
// The second wait (runnerd-codex-transport.test.ts:1155, its wait at :1213)
// spawns the same real `paperclip-runnerd` binary and a real
// `fake-codex-app-server` process, runs one full turn, and waits for the
// runnerd process to write two provider trace files to a terminal status.
// 12 uncontended samples of the time from the start of the turn to both
// trace files first holding `status: "complete"` ranged from 534ms to
// 640ms (median 574.5ms).
//
// The deadline below is over 15 times the larger of the two observed
// maximums (640ms), for machine load worse than either local reproduction
// and for this helper's own 50ms poll granularity.
export const CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS = 10_000;

// A sentinel error thrown when a single attempt runs past the wait's
// remaining deadline. It never leaves `raceAttemptAgainstDeadline` to a
// caller other than `waitForCapabilityLiveProcess`, so a plain class with no
// message is enough to tell it apart from a real attempt failure.
class CapabilityLiveProcessAttemptTimeout extends Error {}

// Run one attempt of `callback` against a deadline of `remainingMs`. A
// pending attempt does not stop when the deadline wins the race, so this
// attaches a no-op rejection handler to the attempt promise. Without that
// handler, an attempt that rejects after its own race has already lost would
// surface as an unhandled rejection instead of the deadline error below.
async function raceAttemptAgainstDeadline<T>(
  callback: () => T | Promise<T>,
  remainingMs: number,
): Promise<T> {
  const attempt = Promise.resolve().then(callback);
  attempt.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CapabilityLiveProcessAttemptTimeout()),
      remainingMs,
    );
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function buildDeadlineExceededError(
  label: string,
  elapsedMs: number,
  lastError: unknown,
): Error {
  const detail =
    lastError instanceof Error
      ? (lastError.stack ?? lastError.message)
      : String(lastError);
  return new Error(
    `Wait for "${label}" did not settle within ${CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS}ms ` +
      `(observed ${elapsedMs}ms). Last observed error: ${detail}`,
    { cause: lastError },
  );
}

/**
 * Poll a capability-live operation that settles only after a real spawned
 * operating-system process does work. Use a deadline derived from the real
 * process envelope described above. Race each attempt against the
 * deadline's remaining time, so a callback that never settles fails at this
 * helper's deadline instead of bypassing it. Unlike a bare `vi.waitFor` or
 * `expect.poll`, report the last observed error when the deadline expires,
 * together with `label` and the elapsed time, so a failure names what the
 * wait was waiting for and how long it waited.
 */
export async function waitForCapabilityLiveProcess<T>(
  label: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const start = Date.now();
  const deadline = start + CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS;
  let lastError: unknown = new Error(
    `no attempt of "${label}" settled before the deadline`,
  );
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw buildDeadlineExceededError(label, Date.now() - start, lastError);
    }
    try {
      return await raceAttemptAgainstDeadline(callback, remainingMs);
    } catch (error) {
      if (error instanceof CapabilityLiveProcessAttemptTimeout) {
        throw buildDeadlineExceededError(
          label,
          Date.now() - start,
          lastError,
        );
      }
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw buildDeadlineExceededError(label, Date.now() - start, lastError);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
