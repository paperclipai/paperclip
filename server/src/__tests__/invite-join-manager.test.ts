import { describe, expect, it } from "vitest";
import {
  resolveJoinRequestAgentManagerId,
  resolveJoinRequestAgentPlacement,
} from "../routes/access.js";

describe("resolveJoinRequestAgentManagerId", () => {
  it("returns null when no CEO exists in the company agent list", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "a1", role: "cto", reportsTo: null },
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
});

describe("resolveJoinRequestAgentPlacement", () => {
  it("promotes the first approved join request to CEO when no agents exist", () => {
    const placement = resolveJoinRequestAgentPlacement([]);

    expect(placement).toEqual({ role: "ceo", reportsTo: null });
  });

  it("creates general agents reporting to CEO once a CEO exists", () => {
    const placement = resolveJoinRequestAgentPlacement([
      { id: "ceo-root", role: "ceo", reportsTo: null },
      { id: "worker", role: "general", reportsTo: "ceo-root" },
    ]);

    expect(placement).toEqual({ role: "general", reportsTo: "ceo-root" });
  });

  it("returns null when company has agents but no active CEO", () => {
    const placement = resolveJoinRequestAgentPlacement([
      { id: "a1", role: "cto", reportsTo: null },
      { id: "a2", role: "engineer", reportsTo: "a1" },
    ]);

    expect(placement).toBeNull();
  });
});
