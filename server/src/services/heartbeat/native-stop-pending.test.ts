import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../errors.js";
import { cancelNativeSession, NativeCancellationPendingRecoveryError } from "../native-runtime/index.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks, runControlPostgresSupport, setupRunControlDatabase } from "./__tests__/run-control-fixtures.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../local-service-supervisor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(async () => undefined),
}));
vi.mock("../native-runtime/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../native-runtime/index.js")>(),
  cancelNativeSession: vi.fn(),
}));

describe.skipIf(!runControlPostgresSupport.supported)("native Stop while the provider session is still starting", () => {
  let db: Db;
  const { fixture } = setupRunControlDatabase("paperclip-heartbeat-native-stop-pending", value => { db = value; });

  async function startingNativeRun() {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "running", runtimeMode: "native", runtimeModeResolvedAt: new Date(),
    }).returning();
    return run;
  }

  // Staging: an operator Stop arrived while a remote native session took longer
  // than the 30s startup wait to open. The Stop was durably recorded and later
  // honored by the startup owner, but the request answered HTTP 500.
  it.each([
    ["startup wait timed out", () => new NativeCancellationPendingRecoveryError()],
    ["remote owner acknowledgement timed out", () => new Error("native_cancellation_pending_recovery")],
  ])("answers a recorded but unacknowledged Stop (%s) with a pending conflict", async (_label, failure) => {
    const run = await startingNativeRun();
    const deps = callbacks(db);
    vi.mocked(cancelNativeSession).mockRejectedValueOnce(failure());
    const error = await createHeartbeatRunControl(db, deps)
      .cancelRunInternal(run.id, "Cancelled by a board operator", { resultJson: { cancelledByActorType: "user", cancelledByUserId: "user-1" } })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409, details: { code: "native_stop_pending", runId: run.id } });
    // Pending is not a cancellation receipt: no terminal transition or release.
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
    expect(deps.finalizeAgentStatus).not.toHaveBeenCalled();
    expect(deps.startNextQueuedRunForAgent).not.toHaveBeenCalled();
    const current = await deps.getRun(run.id);
    expect(current?.status).toBe("running");
    // The Stop intent itself stays recorded for the startup owner to honor.
    expect(current?.resultJson).toMatchObject({ cancellation: expect.any(Object), startupCancellation: expect.any(Object) });
  });

  it("keeps other native Stop failures unchanged", async () => {
    const run = await startingNativeRun();
    const deps = callbacks(db);
    const failure = new Error("native_cancellation_intent_conflict");
    vi.mocked(cancelNativeSession).mockRejectedValueOnce(failure);
    await expect(createHeartbeatRunControl(db, deps).cancelRunInternal(run.id)).rejects.toBe(failure);
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
  });
});
