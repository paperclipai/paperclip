import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

const tracked = vi.hoisted(() => [] as Array<{ runId: string; stage: string; label: string }>);
vi.mock("../run-intake-stall-watch.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../run-intake-stall-watch.js")>();
  return {
    ...actual,
    trackRunIntake: (runId: string, stage: string, label: string, work: () => Promise<unknown>) => {
      tracked.push({ runId, stage, label });
      return work();
    },
  };
});

const { NativeRunCoordinatorStore } = await import("./native-run-coordinator-store.js");

describe("native run coordinator store intake tracking", () => {
  it("registers each appended runner event with the run intake stall watch", async () => {
    const store = new NativeRunCoordinatorStore({} as Db,
      { runId: "run-coordinator" } as ConstructorParameters<typeof NativeRunCoordinatorStore>[1]);
    await expect(store.appendEvent({ eventType: "session.started" } as Parameters<typeof store.appendEvent>[0]))
      .rejects.toThrow("native_event_schema_invalid");
    expect(tracked).toEqual([{ runId: "run-coordinator", stage: "received", label: "session.started" }]);
  });
});
