import { describe, expect, it } from "vitest";
import { gotoAfterServerRestart, isAbortedNavigation } from "./chat-restart.js";

const aborted = () => new Error("page.goto: net::ERR_ABORTED at http://127.0.0.1:1/RUN/issues/RUN-1");
const timeout = () => Object.assign(new Error("page.goto: Timeout 30000ms exceeded."), { name: "TimeoutError" });
function page(outcomes: Array<Error | undefined>) {
  const calls: string[] = [];
  return {
    calls,
    goto: async (url: string) => {
      calls.push(url);
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
      return null;
    },
  };
}

describe("navigation after a server restart", () => {
  it("retries a navigation the old document's reload aborted", async () => {
    const p = page([aborted(), aborted(), undefined]);
    await gotoAfterServerRestart(p as never, "/issue", { deadlineAt: Date.now() + 10_000, retryDelayMs: 0 });
    expect(p.calls).toEqual(["/issue", "/issue", "/issue"]);
  });

  it("keeps tolerating an unsettled lifecycle timeout without retrying", async () => {
    const p = page([timeout()]);
    await gotoAfterServerRestart(p as never, "/issue", { deadlineAt: Date.now() + 10_000, retryDelayMs: 0 });
    expect(p.calls).toHaveLength(1);
  });

  it("rethrows other navigation errors immediately", async () => {
    const p = page([new Error("page.goto: net::ERR_CONNECTION_REFUSED"), undefined]);
    await expect(gotoAfterServerRestart(p as never, "/issue", { deadlineAt: Date.now() + 10_000, retryDelayMs: 0 }))
      .rejects.toThrow("ERR_CONNECTION_REFUSED");
    expect(p.calls).toHaveLength(1);
  });

  it("stops retrying aborts at the attempt bound and at the deadline", async () => {
    const bounded = page([aborted(), aborted(), aborted(), undefined]);
    await expect(gotoAfterServerRestart(bounded as never, "/issue", { deadlineAt: Date.now() + 10_000, retryDelayMs: 0, maxAttempts: 3 }))
      .rejects.toThrow("ERR_ABORTED");
    expect(bounded.calls).toHaveLength(3);
    const late = page([aborted(), undefined]);
    await expect(gotoAfterServerRestart(late as never, "/issue", { deadlineAt: 0, retryDelayMs: 0 })).rejects.toThrow("ERR_ABORTED");
    expect(late.calls).toHaveLength(1);
  });

  it("recognizes only Chromium's aborted-navigation error", () => {
    expect(isAbortedNavigation(aborted())).toBe(true);
    expect(isAbortedNavigation(new Error("net::ERR_ABORTED_SOMETHING"))).toBe(false);
    expect(isAbortedNavigation("net::ERR_ABORTED")).toBe(false);
  });
});
