import { describe, expect, it, vi } from "vitest";
import { AgentDirectoryOperationBusyError } from "../agent-directory-working-copies.js";
import { AgentDirectoryPreparationDeferral, prepareWithAgentDirectoryDeferral, REATTACH_AGENT_DIRECTORY_WAIT_MS } from "./agent-directory-busy.js";

describe("agent directory preparation while another run of the agent holds it", () => {
  it("defers an ordinary start at once, with no wait added to the run-start path", async () => {
    const sleep = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => { throw new AgentDirectoryOperationBusyError(); });
    await expect(prepareWithAgentDirectoryDeferral(prepare, { sleep })).rejects.toBeInstanceOf(AgentDirectoryPreparationDeferral);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("lets a reattach wait its turn in process instead of a deferred full re-preparation", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let attempts = 0;
    const prepare = vi.fn(async () => {
      attempts += 1;
      if (attempts < 4) throw new AgentDirectoryOperationBusyError();
      return "prepared";
    });
    await expect(prepareWithAgentDirectoryDeferral(prepare, { waitMs: REATTACH_AGENT_DIRECTORY_WAIT_MS, sleep })).resolves.toBe("prepared");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
  });

  it("still defers a reattach once its bounded wait runs out", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const sleep = vi.fn(async (ms: number) => { vi.setSystemTime(Date.now() + ms); });
      const prepare = vi.fn(async () => { throw new AgentDirectoryOperationBusyError(); });
      await expect(prepareWithAgentDirectoryDeferral(prepare, { waitMs: 5_000, sleep })).rejects.toBeInstanceOf(AgentDirectoryPreparationDeferral);
      expect(Date.now()).toBeLessThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry other failures", async () => {
    const prepare = vi.fn(async () => { throw new Error("other"); });
    await expect(prepareWithAgentDirectoryDeferral(prepare, { waitMs: 30_000, sleep: async () => undefined })).rejects.toThrow("other");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
