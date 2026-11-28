import { describe, expect, it } from "vitest";
import { resolveJoinRequestAgentManagerId } from "../routes/access.js";

describe("resolveJoinRequestAgentManagerId", () => {
  it("returns null when the company has no agents at all", () => {
    const managerId = resolveJoinRequestAgentManagerId([]);

    expect(managerId).toBeNull();
  });

  it("falls back to the root agent when no CEO-role agent exists (bootstrap gap)", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "a1", role: "cto", reportsTo: null },
      { id: "a2", role: "engineer", reportsTo: "a1" },
    ]);

    expect(managerId).toBe("a1");
  });

  it("falls back to the lowest-id root agent when multiple roots exist and no CEO is present", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "root-1", role: "general", reportsTo: null },
      { id: "root-2", role: "engineer", reportsTo: null },
    ]);

    expect(managerId).toBe("root-1");
  });

  it("picks the same root agent regardless of input order (deterministic across agents.list() ordering)", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "root-2", role: "engineer", reportsTo: null },
      { id: "root-1", role: "general", reportsTo: null },
    ]);

    expect(managerId).toBe("root-1");
  });

  it("returns null when no CEO exists and every agent reports to someone", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "a1", role: "engineer", reportsTo: "ghost" },
    ]);

    expect(managerId).toBeNull();
  });

  it("prefers a CEO over a root agent when both exist", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "root-general", role: "general", reportsTo: null },
      { id: "ceo-1", role: "ceo", reportsTo: "root-general" },
    ]);

    expect(managerId).toBe("ceo-1");
  });

  it("selects the root CEO when available", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-child", role: "ceo", reportsTo: "manager-1" },
      { id: "manager-1", role: "cto", reportsTo: null },
      { id: "ceo-root", role: "ceo", reportsTo: null },
    ]);

    expect(managerId).toBe("ceo-root");
  });

  it("falls back to the first CEO when no root CEO is present", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-1", role: "ceo", reportsTo: "mgr" },
      { id: "ceo-2", role: "ceo", reportsTo: "mgr" },
      { id: "mgr", role: "cto", reportsTo: null },
    ]);

    expect(managerId).toBe("ceo-1");
  });
});
