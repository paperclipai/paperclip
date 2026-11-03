import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { waitForStoppedRuns } from "./wait-for-stopped-runs";

function run(id: string, status: HeartbeatRun["status"]) {
  return { id, status, companyId: "company-1" } as HeartbeatRun;
}
function nativeRun(id: string, receipt: Record<string, unknown> = {}): HeartbeatRun & { runtimeMode: "native" } {
  return {
    ...run(id, "cancelled"), runtimeMode: "native",
    resultJson: { nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", runId: id, companyId: "company-1",
      scope: "run", dispatchState: "acknowledged", ...receipt,
    } },
  };
}
afterEach(() => vi.useRealTimers());
describe("stop confirmation", () => {
  it("waits for embedded ACP acknowledgment even after terminal status", async () => {
    vi.useFakeTimers();
    const getRun = vi.fn()
      .mockResolvedValueOnce({ ...run("acp", "cancelled"), resultJson: { executionCancellation: { state: "requested" } } })
      .mockResolvedValueOnce({ ...run("acp", "cancelled"), resultJson: { executionCancellation: { state: "acknowledged" } } });
    const finished = vi.fn();
    const result = waitForStoppedRuns(["acp"], { getRun }).then(finished);
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(finished).toHaveBeenCalledOnce();
  });
  it("waits for native cancellation acknowledgment after the run becomes terminal", async () => {
    vi.useFakeTimers();
    const native = nativeRun("native");
    const getRun = vi
      .fn()
      .mockResolvedValueOnce({
        ...native,
        resultJson: { nativeCancellation: { ...native.resultJson!.nativeCancellation as object, dispatchState: "pending" } },
      })
      .mockResolvedValueOnce({
        ...native,
        resultJson: { nativeCancellation: native.resultJson!.nativeCancellation },
      });
    const finished = vi.fn();
    const result = waitForStoppedRuns(["native"], { getRun }).then(finished);
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(finished).toHaveBeenCalledOnce();
  });
  it("waits for every affected run, including scheduled retries", async () => {
    vi.useFakeTimers();
    const getRun = vi
      .fn()
      .mockResolvedValueOnce(run("native", "running"))
      .mockResolvedValueOnce(run("legacy", "scheduled_retry"))
      .mockResolvedValueOnce(run("native", "cancelled"))
      .mockResolvedValueOnce(run("legacy", "running"))
      .mockResolvedValueOnce(run("legacy", "cancelled"));
    const finished = vi.fn();
    const result = waitForStoppedRuns(["native", "legacy", "native"], {
      getRun,
    }).then(finished);
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(finished).toHaveBeenCalledOnce();
    expect(getRun).toHaveBeenCalledTimes(5);
  });
  it("does not claim termination when a paused run continues", async () => {
    vi.useFakeTimers();
    const result = waitForStoppedRuns(["active"], {
      getRun: vi.fn().mockResolvedValue(run("active", "running")),
      timeoutMs: 1000,
    });
    const assertion = expect(result).rejects.toThrow(
      "stop was requested, but work is still stopping",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
  it("distinguishes a verification error from a failed pause", async () => {
    await expect(
      waitForStoppedRuns(["active"], {
        getRun: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    ).rejects.toThrow("stop was requested, but stopping could not be verified");
  });
});

it("bounds a hung status request instead of leaving Stop pending forever", async () => {
  vi.useFakeTimers();
  const result = waitForStoppedRuns(["active"], {
    getRun: () => new Promise(() => {}),
    timeoutMs: 1000,
  });
  const assertion = expect(result).rejects.toThrow(
    "stopping could not be verified",
  );
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});


describe("authoritative Stop response", () => {
  it("uses the exact acknowledged cancelled response without a redundant status request", async () => {
    const getRun = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await waitForStoppedRuns(["native"], { initialRuns: [nativeRun("native")], getRun });
    expect(getRun).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", nativeRun("native", { dispatchState: "pending" })],
    ["missing receipt", { ...nativeRun("native"), resultJson: {} }],
    ["missing status", { ...nativeRun("native"), status: undefined } as unknown as HeartbeatRun],
    ["foreign run", nativeRun("other")],
    ["foreign receipt", nativeRun("native", { runId: "other" })],
    ["foreign company", nativeRun("native", { companyId: "other" })],
    ["unknown receipt", nativeRun("native", { schema: "unknown" })],
    ["live run", { ...nativeRun("native"), status: "running" } as HeartbeatRun],
  ])("keeps verifying a %s response", async (_label, initial) => {
    const getRun = vi.fn().mockResolvedValue(nativeRun("native"));
    await waitForStoppedRuns(["native"], { initialRuns: [initial], getRun });
    expect(getRun).toHaveBeenCalledExactlyOnceWith("native");
  });

  it("only removes the confirmed run from a multi-run Stop", async () => {
    const getRun = vi.fn().mockResolvedValue(run("second", "cancelled"));
    await waitForStoppedRuns(["native", "second"], { initialRuns: [nativeRun("native")], getRun });
    expect(getRun).toHaveBeenCalledExactlyOnceWith("second");
  });

  it("rejects a status response for a different run", async () => {
    await expect(waitForStoppedRuns(["native"], {
      getRun: vi.fn().mockResolvedValue(nativeRun("other")),
    })).rejects.toThrow("stopping could not be verified");
  });
});

describe("bounded readonly verification recovery", () => {
  it.each([new TypeError("Failed to fetch"), new ApiError("Unavailable", 503, null)])(
    "recovers a transient status failure within the original deadline: %s", async (error) => {
      vi.useFakeTimers();
      const getRun = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(nativeRun("native"));
      const finished = vi.fn();
      const result = waitForStoppedRuns(["native"], { getRun }).then(finished);
      void result.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await result;
      expect(finished).toHaveBeenCalledOnce();
      expect(getRun).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 403, 404])("does not retry a hard HTTP%s denial", async (status) => {
    const getRun = vi.fn().mockRejectedValue(new ApiError("Denied", status, null));
    await expect(waitForStoppedRuns(["native"], { getRun })).rejects.toThrow("stopping could not be verified");
    expect(getRun).toHaveBeenCalledOnce();
  });

  it("does not extend the deadline or start a request after it expires", async () => {
    vi.useFakeTimers();
    const getRun = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = waitForStoppedRuns(["native"], { getRun, timeoutMs: 1000 });
    const assertion = expect(result).rejects.toThrow("stopping could not be verified");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(getRun).toHaveBeenCalledTimes(2);
  });
});
