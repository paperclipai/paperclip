import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

const stop = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../services/heartbeat.js", () => ({ heartbeatService: () => ({ stopInvocationsForAgents: stop }) }));
vi.mock("../../../services/agent-harness-verification.js", () => ({ agentHarnessVerificationService: () => ({ verify: vi.fn() }) }));
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";

describe("lifecycle host stop scope", () => {
  it("pauses only the requested agent without loading its company peers", async () => {
    // The pause stamps its cause on the agent's own runs (one update), never a peer lookup.
    const update = vi.fn(() => ({ set: () => ({ where: async () => [] }) }));
    const db = { select: vi.fn(() => { throw new Error("No peer lookup expected"); }), update } as unknown as Db;
    const driver = createLifecycleDriver(db, {} as never);
    expect(await driver.runHost({ id: "target", companyId: "company", lifecycleState: "pausing", lifecycleHolds: ["manual"],
      lifecycleVersion: 2, lifecycleRequiredPluginIds: [], lifecycleError: null, lifecycleOperation: null } as never)).toBe("complete");
    expect(update).toHaveBeenCalledOnce();
    // A pause keeps the messages it deferred (work-intent outbox).
    expect(stop).toHaveBeenCalledWith(["target"], "Agent lifecycle stop requested", { preservePauseDeferred: true });
    expect(db.select).not.toHaveBeenCalled();
  });
});
