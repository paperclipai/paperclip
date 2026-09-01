import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

import { cancelHeartbeatNativeRun } from "../services/heartbeat.js";

describe("native heartbeat cancellation authority", () => {
  it("does not enter native cancellation for a direct-adapter run", async () => {
    const cancel = vi.fn();

    await expect(cancelHeartbeatNativeRun({
      db: {} as Db,
      runId: "legacy-run",
      reason: "Cancelled by control plane",
      runtimeMode: "legacy",
      cancel,
    })).resolves.toEqual({ decision: null, auditId: null });

    expect(cancel).not.toHaveBeenCalled();
  });

  it("dispatches pause and bulk cancellation through the audited run scope", async () => {
    const db = {} as Db;
    const cancel = vi.fn(async () => ({
      decision: { reasonCode: "cancellation_run_only" },
      auditId: "audit-1",
    }));

    await expect(cancelHeartbeatNativeRun({
      db,
      runId: "run-1",
      reason: "Cancelled due to agent pause",
      runtimeMode: "native",
      cancel,
    })).resolves.toMatchObject({ auditId: "audit-1" });

    expect(cancel).toHaveBeenCalledWith(
      "run-1",
      "Cancelled due to agent pause",
      { db, scope: "run" },
    );
  });

  it("fails closed when a native cancellation lacks its decision audit", async () => {
    const cancel = vi.fn(async () => ({
      decision: null,
      auditId: null,
    }));

    await expect(cancelHeartbeatNativeRun({
      db: {} as Db,
      runId: "run-2",
      reason: "Cancelled because the agent was terminated",
      runtimeMode: "native",
      cancel,
    })).rejects.toThrow("native_cancellation_outcome_not_audited");
  });
});
