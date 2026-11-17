import { describe, expect, it, vi } from "vitest";
import { deadRunningRun, STALL_LIMIT_MS } from "./grader.js";
import { mergeLiveStatusEvidence, withLiveStatusEvidence } from "./live-status-evidence.js";
import type { RunSample, TaskSample } from "./types.js";

const startedAt = Date.parse("2026-11-10T10:19:56.915Z");
const now = startedAt + STALL_LIMIT_MS + 30_000;
const run = (overrides: Partial<RunSample> = {}): RunSample => ({
  id: "9d39550a", status: "running", createdAt: null, startedAt: new Date(startedAt).toISOString(), finishedAt: null,
  errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null,
  lastEvidenceAt: new Date(startedAt).toISOString(), ...overrides,
});
const sample = (runs: RunSample[]): TaskSample => ({ at: now, reachable: true, serverReady: true, issueStatus: "in_progress", runs }) as TaskSample;
const waiting = { id: "9d39550a", currentStatusMessage: "Waiting for file storage before starting the run log (200s so far)",
  currentStatusUpdatedAt: new Date(now - 10_000).toISOString(), lastEventAt: new Date(now - 10_000).toISOString() };

describe("a run the board shows as waiting for storage (R5)", () => {
  it("is not a silent dead run while its live status stays fresh", () => {
    expect(deadRunningRun(sample([run()]), startedAt)).toMatchObject({ id: "9d39550a" });
    expect(deadRunningRun(sample(mergeLiveStatusEvidence([run()], [waiting])), startedAt)).toBeNull();
  });

  it("still fails a run whose live status went stale too", () => {
    const stale = { ...waiting, currentStatusUpdatedAt: new Date(startedAt).toISOString(), lastEventAt: null };
    expect(deadRunningRun(sample(mergeLiveStatusEvidence([run()], [stale])), startedAt)).toMatchObject({ id: "9d39550a" });
  });

  it("keeps live activity it already saw when a later live read fails", async () => {
    const api = { get: vi.fn(async () => [waiting]) };
    await withLiveStatusEvidence(api as never, "issue-1", [run()]);
    api.get.mockRejectedValueOnce(new Error("unreachable"));
    const [later] = await withLiveStatusEvidence(api as never, "issue-1", [run()]);
    expect(later.lastEvidenceAt).toBe(waiting.currentStatusUpdatedAt);
    expect(deadRunningRun(sample([later]), startedAt)).toBeNull();
  });

  it("reads live status only while a run is running, and tolerates a failed read", async () => {
    const get = vi.fn(async () => [waiting]);
    expect(await withLiveStatusEvidence({ get } as never, "issue-1", [run({ status: "succeeded" })])).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
    const [merged] = await withLiveStatusEvidence({ get } as never, "issue-1", [run()]);
    expect(get).toHaveBeenCalledWith("/api/issues/issue-1/live-runs", 5_000);
    expect(merged.lastEvidenceAt).toBe(waiting.currentStatusUpdatedAt);
    const failing = { get: vi.fn(async (): Promise<unknown> => { throw new Error("unreachable"); }) };
    expect(await withLiveStatusEvidence(failing as never, "issue-1", [run()])).toEqual([run()]);
  });
});
