import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `middleware/logger.ts` builds its non-production pino instance on top of a
 * `pino.transport` pretty-printer, which spawns a worker thread. Nothing hands
 * this module a handle to close that worker, so a module-registry reset that
 * re-evaluates the module leaks one worker — thread, MessagePort and V8
 * isolate — per evaluation, for the life of the process.
 *
 * That is not hypothetical: 46 files under `server/src/__tests__` call
 * `vi.resetModules()` in `beforeEach` and then re-import a module that reaches
 * this one, so a 50-test suite re-evaluates it 50 times. This test pins the
 * transport to one per process, and fails if the cache is ever removed.
 */

/**
 * Count the live `pino.transport` workers, one MessagePort each. Reading active
 * resources is portable; reading /proc/self/task would pin this test to Linux.
 */
function messagePortCount() {
  return process.getActiveResourcesInfo().filter((resource) => resource === "MessagePort").length;
}

describe("pretty-print transport reuse across module-registry resets", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("spawns no additional worker when the logger module is re-evaluated", async () => {
    // Evaluate once first so the baseline already includes this process's one
    // transport; the assertion is then purely about what the *extra*
    // evaluations cost.
    await vi.importActual<typeof import("../middleware/logger.js")>("../middleware/logger.js");
    const baseline = messagePortCount();

    for (let evaluation = 0; evaluation < 10; evaluation += 1) {
      vi.resetModules();
      await vi.importActual<typeof import("../middleware/logger.js")>("../middleware/logger.js");
    }

    // Before the fix this grew by exactly one per evaluation (10 here, 50 in a
    // full route suite). An exact-equality assertion would be hostage to any
    // unrelated MessagePort the runner happens to open mid-test, so allow a
    // small constant — anything proportional to the loop count still fails.
    expect(messagePortCount() - baseline).toBeLessThanOrEqual(2);
  });

  it("hands every re-evaluated module instance the same transport object", async () => {
    const first = await vi.importActual<typeof import("../middleware/logger.js")>("../middleware/logger.js");
    const firstTransport = (globalThis as Record<string, unknown>).__paperclipPinoPrettyTransport;
    expect(firstTransport).toBeDefined();

    vi.resetModules();
    const second = await vi.importActual<typeof import("../middleware/logger.js")>("../middleware/logger.js");

    // Distinct module instances — the registry really was reset …
    expect(second.logger).not.toBe(first.logger);
    // … sharing the one cached transport, which is what keeps the worker count
    // flat. Identity, not mere presence: a per-evaluation transport would also
    // leave something defined here.
    expect((globalThis as Record<string, unknown>).__paperclipPinoPrettyTransport).toBe(firstTransport);
  });
});
