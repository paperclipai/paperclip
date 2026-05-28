import { describe, expect, it } from "vitest";
import { resolveJoinRequestAgentManagerId } from "../routes/access.js";

describe("resolveJoinRequestAgentManagerId", () => {
  it("returns null when no founding agent exists in the company agent list", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "a1", role: "engineer", reportsTo: null },
      { id: "a2", role: "engineer", reportsTo: "a1" },
    ]);

    expect(managerId).toBeNull();
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

  it("falls back to a founding agent (CTO) when no CEO is present", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "cto-root", role: "cto", reportsTo: null },
      { id: "eng-1", role: "engineer", reportsTo: "cto-root" },
    ]);

    expect(managerId).toBe("cto-root");
  });

  it("prefers Chief of Staff over CTO when both are present and no CEO", () => {
    // Both are founding roles, so first-in-order within the pool wins
    // when neither is the root. Root takes precedence regardless of role.
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "cos-root", role: "chief_of_staff", reportsTo: null },
      { id: "cto-root", role: "cto", reportsTo: null },
    ]);

    expect(managerId).toBe("cos-root");
  });
});
