import { describe, expect, it } from "vitest";
import { resolveJoinRequestAgentManagerId } from "../routes/access.js";

describe("resolveJoinRequestAgentManagerId", () => {
  it("returns null when no CEO exists in the company agent list", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "a1", role: "cto", managerIds: [] },
      { id: "a2", role: "engineer", managerIds: ["a1"] },
    ]);

    expect(managerId).toBeNull();
  });

  it("selects the root CEO when available", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-child", role: "ceo", managerIds: ["manager-1"] },
      { id: "manager-1", role: "cto", managerIds: [] },
      { id: "ceo-root", role: "ceo", managerIds: [] },
    ]);

    expect(managerId).toBe("ceo-root");
  });

  it("falls back to the first CEO when no root CEO is present", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-1", role: "ceo", managerIds: ["mgr"] },
      { id: "ceo-2", role: "ceo", managerIds: ["mgr"] },
      { id: "mgr", role: "cto", managerIds: [] },
    ]);

    expect(managerId).toBe("ceo-1");
  });
});
