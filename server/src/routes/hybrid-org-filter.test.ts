import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { HybridOrgNode } from "@paperclipai/shared";
import { filterHybridOrgForActor } from "./hybrid-org-filter.js";

describe("filterHybridOrgForActor", () => {
  const nodes: HybridOrgNode[] = [{
    id: "ceo",
    kind: "agent",
    name: "CEO",
    role: "ceo",
    title: null,
    status: "active",
    reports: [{
      id: "worker",
      kind: "agent",
      name: "Worker",
      role: "engineer",
      title: null,
      status: "active",
      reports: [],
    }],
  }];

  it("promotes readable reports when the parent agent is denied", async () => {
    const req = { actor: { type: "agent", agentId: "worker" } } as unknown as Request;
    const decideAgentRead = vi.fn(async (_req, agent) => ({
      allowed: agent.id === "worker",
    }));
    const filtered = await filterHybridOrgForActor(req, nodes, "company", decideAgentRead);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("worker");
    expect(filtered.some((node) => node.id === "ceo")).toBe(false);
  });
});
