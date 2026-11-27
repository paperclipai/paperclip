import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { agentIdFromChatValue, chatAgentOptions, defaultChatAgent } from "./dashboard-chat";

const agent = (id: string, createdAt: string, overrides: Partial<Agent> = {}) =>
  ({ id, name: id.toUpperCase(), role: "general", title: null, status: "idle", createdAt: new Date(createdAt), ...overrides }) as Agent;

describe("defaultChatAgent", () => {
  it("is the first agent created in the organization", () => {
    const agents = [agent("b", "2026-02-01"), agent("a", "2026-01-01"), agent("c", "2026-03-01")];
    expect(defaultChatAgent(agents)?.id).toBe("a");
  });

  it("skips agents that cannot be chatted with: terminated or awaiting approval", () => {
    const agents = [
      agent("gone", "2025-01-01", { status: "terminated" }),
      agent("waiting", "2025-02-01", { status: "pending_approval" }),
      agent("paused", "2025-03-01", { status: "paused" }),
      agent("later", "2025-04-01"),
    ];
    expect(defaultChatAgent(agents)?.id).toBe("paused");
  });

  it("breaks a tie by id, and is null with no agents", () => {
    expect(defaultChatAgent([agent("z", "2026-01-01"), agent("m", "2026-01-01")])?.id).toBe("m");
    expect(defaultChatAgent([])).toBeNull();
    expect(defaultChatAgent([agent("gone", "2025-01-01", { status: "terminated" })])).toBeNull();
  });
});

describe("chatAgentOptions", () => {
  it("offers the same agents as the task composer, recently chosen first, as agent values", () => {
    const agents = [agent("a", "2026-01-01"), agent("b", "2026-02-01"), agent("gone", "2026-03-01", { status: "terminated" })];
    expect(chatAgentOptions(agents, ["b"]).map((option) => [option.id, option.label])).toEqual([
      ["agent:b", "B"],
      ["agent:a", "A"],
    ]);
  });

  it("reads the agent back out of a value", () => {
    expect(agentIdFromChatValue("agent:a")).toBe("a");
    expect(agentIdFromChatValue("user:a")).toBeNull();
    expect(agentIdFromChatValue("")).toBeNull();
  });
});
