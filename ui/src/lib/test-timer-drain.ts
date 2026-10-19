/**
 * Test support. An unmount can queue a 0 ms timer: Radix FocusScope dispatches its unmount event from one. A
 * test file whose last test unmounts such a component must let that timer run before the file's jsdom is torn down;
 * run afterwards, it builds the event from Node's CustomEvent and jsdom refuses it ("parameter 1 is not of type
 * 'Event'"), failing the worker with an unhandled error. vitest.setup.ts runs `drainQueuedTimers` after each file.
 *
 * The scheduler is captured when this module loads, which the setup file does before the file's tests run, so a test
 * that leaves fake timers installed cannot stop the drain.
 */
const schedule = globalThis.setTimeout;

/** Resolves on a 0 ms timer of its own, which Node runs after the 0 ms timers queued before it. */
export function drainQueuedTimers(): Promise<void> {
  return new Promise((resolve) => {
    schedule(resolve, 0);
  });
}
