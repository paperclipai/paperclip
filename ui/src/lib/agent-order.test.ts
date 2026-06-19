import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { sortAgentsByDefaultSidebarOrder, sortAgentsByStoredOrder } from "./agent-order";

function makeAgent(overrides: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    role: "general",
    reportsTo: null,
    ...overrides,
  } as Agent;
}

describe("sortAgentsByDefaultSidebarOrder", () => {
  it("surfaces the CEO ahead of alphabetically-earlier root agents when leadershipFirst is on", () => {
    // "Board" sorts before "CEO" alphabetically, but the CEO should win.
    const agents = [
      makeAgent({ id: "board", name: "Board", role: "general" }),
      makeAgent({ id: "ceo", name: "CEO", role: "ceo" }),
      makeAgent({ id: "ada", name: "Ada", role: "engineer" }),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents, { leadershipFirst: true });
    expect(sorted.map((a) => a.id)).toEqual(["ceo", "ada", "board"]);
  });

  it("keeps master's plain alphabetical order by default (Conference Room Chat flag off)", () => {
    const agents = [
      makeAgent({ id: "board", name: "Board", role: "general" }),
      makeAgent({ id: "ceo", name: "CEO", role: "ceo" }),
      makeAgent({ id: "ada", name: "Ada", role: "engineer" }),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents);
    expect(sorted.map((a) => a.id)).toEqual(["ada", "board", "ceo"]);
  });

  it("ranks leadership roles before non-leadership, then alphabetically", () => {
    const agents = [
      makeAgent({ id: "eng", name: "Zoe", role: "engineer" }),
      makeAgent({ id: "cmo", name: "Mira", role: "cmo" }),
      makeAgent({ id: "ceo", name: "Sam", role: "ceo" }),
      makeAgent({ id: "cto", name: "Tom", role: "cto" }),
      makeAgent({ id: "qa", name: "Amy", role: "qa" }),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents, { leadershipFirst: true });
    // ceo, cto, cmo (leadership in priority order), then Amy, Zoe alphabetically.
    expect(sorted.map((a) => a.id)).toEqual(["ceo", "cto", "cmo", "qa", "eng"]);
  });

  it("keeps reports nested under their leader while ordering siblings by role", () => {
    const agents = [
      makeAgent({ id: "ceo", name: "Sam", role: "ceo" }),
      makeAgent({ id: "eng", name: "Zoe", role: "engineer", reportsTo: "ceo" }),
      makeAgent({ id: "cto", name: "Tom", role: "cto", reportsTo: "ceo" }),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents, { leadershipFirst: true });
    // Root CEO first, then its reports with the CTO (leadership) ahead of the engineer.
    expect(sorted.map((a) => a.id)).toEqual(["ceo", "cto", "eng"]);
  });

  it("respects an explicit stored order over the role-priority default", () => {
    const agents = [
      makeAgent({ id: "ceo", name: "Sam", role: "ceo" }),
      makeAgent({ id: "board", name: "Board", role: "general" }),
    ];
    const sorted = sortAgentsByStoredOrder(agents, ["board", "ceo"], { leadershipFirst: true });
    expect(sorted.map((a) => a.id)).toEqual(["board", "ceo"]);
  });
});
