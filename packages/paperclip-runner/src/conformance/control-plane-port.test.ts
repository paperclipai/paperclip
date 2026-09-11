import { describe, expect, it } from "vitest";

import { MockControlPlaneAdapter } from "../mock-core/mock-control-plane-adapter.js";
import {
  CONTROL_PLANE_CONFORMANCE_EVENTS,
  CONTROL_PLANE_CONFORMANCE_OPEN,
  runControlPlanePortConformance,
} from "./control-plane-port.js";

describe("ControlPlanePort conformance", () => {
  it("runs unchanged against the mock adapter", async () => {
    const adapter = new MockControlPlaneAdapter();
    await expect(runControlPlanePortConformance({
      port: adapter,
      start: () => adapter.start(),
      stop: () => adapter.stop(),
    })).resolves.toEqual({
      eventCount: 3,
      highestContiguousSourceSeq: 3,
      duplicateDisposition: "duplicate",
      terminalReplayIdempotent: true,
      openBindingRejected: true,
      eventIdMutationRejected: true,
      eventSequenceMutationRejected: true,
      replayBindingRejected: true,
      resultMutationRejected: true,
    });
  });

  it("fails closed when a source identity is replayed with different bytes", async () => {
    const adapter = new MockControlPlaneAdapter();
    await adapter.start();
    await adapter.openRun(CONTROL_PLANE_CONFORMANCE_OPEN);
    await adapter.appendEvent(CONTROL_PLANE_CONFORMANCE_EVENTS[0]);
    await expect(adapter.appendEvent({
      ...CONTROL_PLANE_CONFORMANCE_EVENTS[0],
      payload: { backend: "forged" },
    })).rejects.toThrow("native_event_replay_conflict");
  });
});
