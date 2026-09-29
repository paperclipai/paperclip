import { describe, expect, it } from "vitest";
import { decideCancelAuth } from "../routes/agents.js";

const agentId = "agent-self-1";
const otherAgentId = "agent-other-1";
const userId = "local-board";

describe("decideCancelAuth (SPA-9035)", () => {
  it("allows an agent to cancel a run it itself initiated (automation)", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId,
        invocationSource: "automation",
        status: "queued",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
      },
    );
    expect(decision).toMatchObject({
      ok: true,
      cancelledByActorType: "agent",
      cancelReason: "Cancelled by the owning agent",
      activityActorType: "agent",
      activityActorId: agentId,
    });
    expect(decision.ok && decision.resultJsonPatch).toEqual({
      cancelledByActorType: "agent",
      cancelledByAgentId: agentId,
    });
  });

  it("allows an agent to cancel a run it itself initiated (on_demand, running)", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId,
        invocationSource: "on_demand",
        status: "running",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
      },
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.cancelledByActorType).toBe("agent");
      expect(decision.resultJsonPatch.cancelledByAgentId).toBe(agentId);
    }
  });

  it("forbids an agent from cancelling another agent's run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId: otherAgentId,
        invocationSource: "automation",
        status: "queued",
        requestedByActorType: "agent",
        requestedByActorId: otherAgentId,
      },
    );
    expect(decision).toEqual({
      ok: false,
      status: 403,
      error: "Agent can only cancel a run it itself started",
    });
  });

  it("forbids an agent from cancelling a system-initiated run even when assigned to it", () => {
    // The assigned agent does not own the wake. Recovery paths, comment
    // follow-ups, productivity-review jobs — none of these should be
    // revocable by the assigned agent.
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId,
        invocationSource: "automation",
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: null,
      },
    );
    expect(decision).toEqual({
      ok: false,
      status: 403,
      error: "Agent can only cancel a run it itself started",
    });
  });

  it("forbids an agent from cancelling a user-initiated run even when assigned to it", () => {
    // User-originated approval wakes land on the agent but the user owns
    // them. Self-cancel would let the assigned agent quietly kill work the
    // user just kicked off.
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId,
        invocationSource: "on_demand",
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: userId,
      },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(403);
  });

  it("forbids an agent from cancelling an orphan run (no initiator recorded)", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId,
        invocationSource: "automation",
        status: "queued",
        requestedByActorType: null,
        requestedByActorId: null,
      },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(403);
  });

  it("returns 409 when an agent tries to cancel an already-terminal run", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId,
        invocationSource: "automation",
        status: "cancelled",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
      },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.status).toBe(409);
      expect(decision.error).toContain("cancelled");
    }
  });

  it("returns 409 for a run already in succeeded state", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId },
      {
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
      },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(409);
  });

  it("allows a board user to cancel any run regardless of initiator", () => {
    const decision = decideCancelAuth(
      { type: "user", userId },
      {
        agentId,
        invocationSource: "timer",
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: null,
      },
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.cancelledByActorType).toBe("user");
      expect(decision.activityActorType).toBe("user");
      expect(decision.activityActorId).toBe(userId);
      expect(decision.resultJsonPatch).toEqual({
        cancelledByActorType: "user",
        cancelledByUserId: userId,
      });
    }
  });

  it("handles a null actor.agentId gracefully (rejects)", () => {
    const decision = decideCancelAuth(
      { type: "agent", agentId: null },
      {
        agentId,
        invocationSource: "automation",
        status: "queued",
        requestedByActorType: "agent",
        requestedByActorId: agentId,
      },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.status).toBe(403);
  });
});