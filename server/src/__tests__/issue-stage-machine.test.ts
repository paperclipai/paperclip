import { describe, expect, it } from "vitest";
import { evaluateStageTransition } from "../services/issue-stage-machine.js";

describe("issue stage machine", () => {
  const user = "user" as const;

  it("allows forward board moves", () => {
    expect(evaluateStageTransition({ from: "todo", to: "in_progress", actorType: user, workflowControlled: false }).allowed).toBe(true);
    expect(evaluateStageTransition({ from: "in_progress", to: "in_review", actorType: user, workflowControlled: false }).allowed).toBe(true);
    expect(evaluateStageTransition({ from: "in_review", to: "done", actorType: user, workflowControlled: false }).allowed).toBe(true);
  });

  it("blocks manual backward drag through the review gate", () => {
    expect(evaluateStageTransition({ from: "in_review", to: "in_progress", actorType: user, workflowControlled: false }).allowed).toBe(false);
    expect(evaluateStageTransition({ from: "done", to: "in_review", actorType: user, workflowControlled: false }).allowed).toBe(false);
    expect(evaluateStageTransition({ from: "done", to: "in_progress", actorType: user, workflowControlled: false }).allowed).toBe(false);
  });

  it("exempts workflow-controlled loopback (changes_requested)", () => {
    expect(evaluateStageTransition({ from: "in_review", to: "in_progress", actorType: user, workflowControlled: true }).allowed).toBe(true);
  });

  it("exempts agent/engine actors entirely", () => {
    expect(evaluateStageTransition({ from: "in_review", to: "in_progress", actorType: "agent", workflowControlled: false }).allowed).toBe(true);
  });

  it("always allows cancel (stop) from anywhere", () => {
    expect(evaluateStageTransition({ from: "in_review", to: "cancelled", actorType: user, workflowControlled: false }).allowed).toBe(true);
    expect(evaluateStageTransition({ from: "done", to: "cancelled", actorType: user, workflowControlled: false }).allowed).toBe(true);
  });

  it("allows reopening a closed card back to the Open column", () => {
    expect(evaluateStageTransition({ from: "done", to: "todo", actorType: user, workflowControlled: false }).allowed).toBe(true);
    expect(evaluateStageTransition({ from: "cancelled", to: "todo", actorType: user, workflowControlled: false }).allowed).toBe(true);
  });

  it("treats blocked and in_progress as the same stage", () => {
    expect(evaluateStageTransition({ from: "blocked", to: "in_progress", actorType: user, workflowControlled: false }).allowed).toBe(true);
    expect(evaluateStageTransition({ from: "in_progress", to: "blocked", actorType: user, workflowControlled: false }).allowed).toBe(true);
  });

  it("no-ops on identical status", () => {
    expect(evaluateStageTransition({ from: "done", to: "done", actorType: user, workflowControlled: false }).allowed).toBe(true);
  });
});
