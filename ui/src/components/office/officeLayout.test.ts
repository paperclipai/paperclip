import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  curatedSubset,
  departmentForRole,
  layoutOffice,
  packRooms,
  type Department,
} from "./officeLayout";

function mkAgent(partial: Partial<Agent> & { id: string }): Agent {
  return {
    companyId: "c1",
    name: partial.id,
    urlKey: partial.id,
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...partial,
  } as Agent;
}

function overlaps(a: { ox: number; oy: number; w: number; h: number }, b: typeof a): boolean {
  return a.ox < b.ox + b.w && b.ox < a.ox + a.w && a.oy < b.oy + b.h && b.oy < a.oy + a.h;
}

describe("officeLayout.packRooms", () => {
  it("never overlaps two rooms in cell space", () => {
    const counts: Array<{ department: Department; count: number }> = [
      { department: "Executive", count: 1 },
      { department: "Engineering", count: 7 },
      { department: "Product", count: 2 },
      { department: "Design", count: 3 },
      { department: "Quality", count: 4 },
    ];
    const rects = packRooms(counts, 3);
    expect(rects).toHaveLength(counts.length);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });
});

describe("officeLayout.curatedSubset", () => {
  const agents: Agent[] = [
    mkAgent({ id: "ceo", role: "ceo", reportsTo: null }),
    mkAgent({ id: "eng-lead", role: "engineer", reportsTo: "ceo" }),
    mkAgent({ id: "eng-junior", role: "engineer", reportsTo: "eng-lead" }),
    mkAgent({ id: "qa1", role: "qa", reportsTo: "ceo" }),
    mkAgent({ id: "dead-eng", role: "engineer", reportsTo: "ceo", status: "terminated" }),
  ];

  it("includes every root", () => {
    const ids = new Set(curatedSubset(agents).map((a) => a.id));
    expect(ids.has("ceo")).toBe(true);
  });

  it("picks one representative per present department by shallowest depth", () => {
    const result = curatedSubset(agents);
    const engineers = result.filter((a) => departmentForRole(a.role) === "Engineering");
    expect(engineers).toHaveLength(1);
    expect(engineers[0]!.id).toBe("eng-lead"); // shallower than eng-junior
    expect(result.some((a) => a.id === "qa1")).toBe(true);
  });

  it("never includes terminated agents", () => {
    expect(curatedSubset(agents).some((a) => a.status === "terminated")).toBe(false);
  });
});

describe("officeLayout.layoutOffice", () => {
  it("returns a desk per visible agent and positive bounds", () => {
    const agents: Agent[] = [
      mkAgent({ id: "ceo", role: "ceo", reportsTo: null }),
      mkAgent({ id: "e1", role: "engineer", reportsTo: "ceo" }),
      mkAgent({ id: "e2", role: "engineer", reportsTo: "ceo" }),
      mkAgent({ id: "gone", role: "engineer", reportsTo: "ceo", status: "terminated" }),
    ];
    const layout = layoutOffice(agents, 3);
    // "gone" is terminated but layoutOffice lays out whatever roster it is given;
    // the caller filters. Here we pass all 4, so 4 desks.
    expect(layout.desks).toHaveLength(4);
    expect(layout.bounds.width).toBeGreaterThan(0);
    expect(layout.bounds.height).toBeGreaterThan(0);
    // Executive + Engineering => 2 rooms.
    expect(layout.rooms.map((r) => r.department).sort()).toEqual(["Engineering", "Executive"]);
  });

  it("handles an empty roster", () => {
    const layout = layoutOffice([], 3);
    expect(layout.desks).toHaveLength(0);
    expect(layout.rooms).toHaveLength(0);
    expect(layout.bounds.width).toBeGreaterThan(0);
  });
});
