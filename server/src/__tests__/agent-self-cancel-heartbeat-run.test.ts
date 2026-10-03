import { describe, expect, it } from "vitest";
import { decideCancelAuth } from "../routes/agents.js";

describe("decideCancelAuth", () => {
  it("allows a board operator to cancel any run", () => {
    const actor = { userId: "user-123" };
    const run = { agentId: "agent-1", invocationSource: "timer" };
    expect(decideCancelAuth(actor, run)).toEqual({
      authorized: true,
      actorType: "user",
      actorId: "user-123",
    });
  });

  it("allows an agent to cancel its own automation run", () => {
    const actor = { agentId: "agent-1" };
    const run = { agentId: "agent-1", invocationSource: "automation" };
    expect(decideCancelAuth(actor, run)).toEqual({
      authorized: true,
      actorType: "agent",
      actorId: "agent-1",
    });
  });

  it("allows an agent to cancel its own on_demand run", () => {
    const actor = { agentId: "agent-1" };
    const run = { agentId: "agent-1", invocationSource: "on_demand" };
    expect(decideCancelAuth(actor, run)).toEqual({
      authorized: true,
      actorType: "agent",
      actorId: "agent-1",
    });
  });

  it("rejects an agent trying to cancel another agent's run", () => {
    const actor = { agentId: "agent-2" };
    const run = { agentId: "agent-1", invocationSource: "automation" };
    expect(decideCancelAuth(actor, run)).toMatchObject({
      authorized: false,
    });
  });

  it("rejects an agent trying to cancel its own timer run", () => {
    const actor = { agentId: "agent-1" };
    const run = { agentId: "agent-1", invocationSource: "timer" };
    expect(decideCancelAuth(actor, run)).toMatchObject({
      authorized: false,
    });
  });

  it("rejects an agent trying to cancel its own assignment run", () => {
    const actor = { agentId: "agent-1" };
    const run = { agentId: "agent-1", invocationSource: "assignment" };
    expect(decideCancelAuth(actor, run)).toMatchObject({
      authorized: false,
    });
  });

  it("rejects an agent trying to cancel a board-started on_demand run", () => {
    const actor = { agentId: "agent-1" };
    const run = { agentId: "agent-1", invocationSource: "on_demand", responsibleUserId: "user-123" };
    expect(decideCancelAuth(actor, run)).toMatchObject({
      authorized: false,
    });
  });
});
