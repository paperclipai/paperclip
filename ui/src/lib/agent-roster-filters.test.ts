import type { Agent, AiConnectionList } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { AGENT_DEPARTMENT_UNASSIGNED, buildAgentRosterIndex, departmentNamesForAgent, emptyAgentRosterFilters, matchesAgentRosterFilters, matchesDepartmentFilter } from "./agent-roster-filters";

const connectionId = "11111111-1111-4111-8111-111111111111";
const otherConnectionId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const agent = (id: string, overrides: Partial<Agent> = {}) => ({
  id, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, ...overrides,
}) as Agent;
const binding = (id = connectionId) => ({ provider: "openai", method: "api_key", mode: "shared", connectionId: id, grantId } as const);

describe("agent roster filters", () => {
  it("intersects all four filters using connection identity even when names are equal", () => {
    const agents = [
      agent("match", { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: " custom-model " }, runtimeConfig: { aiConnection: binding() } }),
      agent("other-connection", { adapterConfig: { model: "custom-model" }, runtimeConfig: { aiConnection: binding(otherConnectionId) } }),
      agent("other-model", { adapterConfig: { model: "another-model" }, runtimeConfig: { aiConnection: binding() } }),
      agent("other-status", { status: "paused", adapterConfig: { model: "custom-model" }, runtimeConfig: { aiConnection: binding() } }),
      agent("other-harness", { adapterType: "claude_local", adapterConfig: { model: "custom-model" }, runtimeConfig: { aiConnection: binding() } }),
    ];
    const accounts = { connections: [connectionId, otherConnectionId].map(id => ({ id, grantId, name: "Team" })) } as AiConnectionList;
    const { byAgentId, options } = buildAgentRosterIndex(agents, accounts);
    const filters = { model: "model:custom-model", harness: "codex_local", status: "idle", connection: `connection:${connectionId}` };
    expect(agents.filter(a => matchesAgentRosterFilters(byAgentId.get(a.id), filters)).map(a => a.id)).toEqual(["match"]);
    expect(options.connection).toHaveLength(2);
    expect(options.connection.map(c => c.label)).toEqual(["Team (1)", "Team (2)"]);
    expect(byAgentId.get("match")?.connection.label).toBe("Team (1)");
    expect(byAgentId.get("other-model")?.connection.label).toBe("Team (1)");
    expect(options.model.map(m => m.label)).toEqual(["another-model", "custom-model"]);
    expect(agents.filter(a => matchesAgentRosterFilters(byAgentId.get(a.id), emptyAgentRosterFilters))).toEqual(agents);
  });

  it("represents defaults, pending setup, external agents, responsible defaults and pools as displayed", () => {
    const agents = [agent("local"), agent("external", { adapterType: "http" }),
      agent("responsible", { runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "openai", method: "subscription" } } }),
      agent("pool", { runtimeConfig: { aiConnection: { mode: "router", connectionId } } }),
      agent("pending", { status: "paused", adapterType: "process", pauseReason: "setup", metadata: {
        setupAdapterPending: true, setupAdapterChoice: { adapterType: "paperclip_runner", runnerProvider: "antigravity", runner: "auto" },
      } }), agent("hidden", { status: "terminated", adapterConfig: { model: "hidden-model" } }), agent("approval", { status: "pending_approval" }),
    ];
    const { byAgentId, options } = buildAgentRosterIndex(agents);
    expect(byAgentId.get("pending")?.harness.value).toBe("antigravity_runtime");
    expect(byAgentId.get("pending")?.model.label).toBe("Not available yet");
    expect(options.connection.map(c => c.label)).toEqual(["Connection pool", "Local credentials", "Managed externally", "Not configured", "Responsible user's default"]);
    expect(options.model.map(m => m.label)).toEqual(["Harness default", "Not available yet"]);
    expect(byAgentId.has("hidden")).toBe(false);
    expect(byAgentId.has("approval")).toBe(false);
    expect(options.status.map(s => s.value)).toEqual(["idle", "paused"]);
    expect(matchesAgentRosterFilters(byAgentId.get("local"), { ...emptyAgentRosterFilters, model: "missing" })).toBe(false);
  });

  it("indexes hundreds of connection names once for a large roster", () => {
    let reads = 0;
    const id = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const connections = Array.from({ length: 500 }, (_, i) => ({ get id() {
      if (++reads > 500) throw new Error("Connections were scanned for each agent");
      return id(i);
    }, grantId, name: `Account ${i}` }));
    const agents = Array.from({ length: 1000 }, (_, i) => agent(String(i), { runtimeConfig: { aiConnection: binding(id(i % 500)) } }));
    const { byAgentId } = buildAgentRosterIndex(agents, { connections } as AiConnectionList);
    expect(byAgentId.size).toBe(1000);
    expect(reads).toBe(500);
  });
});

describe("department roster filter", () => {
  const departments = [
    { id: "accounting", name: "Accounting", agentIds: ["shared", "books"] },
    { id: "paperclip", name: "Paperclip", agentIds: ["shared", "dev"] },
  ];

  it("matches every department an agent belongs to and treats no rows as unassigned", () => {
    expect(matchesDepartmentFilter("shared", "accounting", departments)).toBe(true);
    expect(matchesDepartmentFilter("shared", "paperclip", departments)).toBe(true);
    expect(matchesDepartmentFilter("dev", "accounting", departments)).toBe(false);
    expect(matchesDepartmentFilter("books", AGENT_DEPARTMENT_UNASSIGNED, departments)).toBe(false);
    expect(matchesDepartmentFilter("visitor", AGENT_DEPARTMENT_UNASSIGNED, departments)).toBe(true);
    expect(matchesDepartmentFilter("visitor", "", departments)).toBe(true);
    expect(departmentNamesForAgent("shared", departments)).toEqual(["Accounting", "Paperclip"]);
  });
});
