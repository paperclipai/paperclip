import { describe, expect, it } from "vitest";
import { shouldWakeAgentForComment } from "../routes/issues.js";

describe("shouldWakeAgentForComment", () => {
  it("wakes assignee when comment is from board user", () => {
    expect(
      shouldWakeAgentForComment(
        { actorType: "user", agentId: null },
        "agent-1",
      ),
    ).toBe(true);
  });

  it("does not wake the same agent that authored the comment", () => {
    expect(
      shouldWakeAgentForComment(
        { actorType: "agent", agentId: "agent-1" },
        "agent-1",
      ),
    ).toBe(false);
  });

  it("still wakes other agents for agent-authored comments", () => {
    expect(
      shouldWakeAgentForComment(
        { actorType: "agent", agentId: "agent-1" },
        "agent-2",
      ),
    ).toBe(true);
  });

  it("does not wake when there is no target agent", () => {
    expect(
      shouldWakeAgentForComment(
        { actorType: "user", agentId: null },
        null,
      ),
    ).toBe(false);
  });
});
