import { describe, expect, it } from "vitest";
import {
  getAgentFallbackLane,
  getAgentModelBadge,
  getAgentRegistryLaneRole,
  groupAgentFallbackLanes,
  groupAgentFallbackLanesWithRegistry,
} from "./agent-lanes";

describe("getAgentFallbackLane", () => {
  it("detects known lane suffixes", () => {
    expect(getAgentFallbackLane("GLaD0S-Codex")).toEqual({ base: "GLaD0S", lane: "Codex" });
    expect(getAgentFallbackLane("Kestrel-Grok")).toEqual({ base: "Kestrel", lane: "Grok" });
    expect(getAgentFallbackLane("Athena-Hermes")).toEqual({ base: "Athena", lane: "Hermes" });
    expect(getAgentFallbackLane("RoutineOps-Gemini")).toEqual({ base: "RoutineOps", lane: "Gemini" });
  });

  it("ignores non-lane names", () => {
    expect(getAgentFallbackLane("GLaD0S")).toBeNull();
    expect(getAgentFallbackLane("CodexEngineer")).toBeNull();
    expect(getAgentFallbackLane("MC-Compiler")).toBeNull();
    expect(getAgentFallbackLane("-Codex")).toBeNull();
  });
});

describe("groupAgentFallbackLanes", () => {
  it("moves clones directly after their primary, preserving relative order", () => {
    const names = ["GLaD0S-Grok", "Astra", "GLaD0S", "Astra-Codex", "GLaD0S-Codex", "RoutingPA"];
    const grouped = groupAgentFallbackLanes(names.map((name) => ({ name }))).map((a) => a.name);
    expect(grouped).toEqual(["Astra", "Astra-Codex", "GLaD0S", "GLaD0S-Grok", "GLaD0S-Codex", "RoutingPA"]);
  });

  it("leaves clones without a primary in place", () => {
    const names = ["GrowthSEO-Gemini", "Kestrel"];
    const grouped = groupAgentFallbackLanes(names.map((name) => ({ name }))).map((a) => a.name);
    expect(grouped).toEqual(["GrowthSEO-Gemini", "Kestrel"]);
  });
});

describe("getAgentModelBadge", () => {
  it("shows antigravity as a fixed adapter identity instead of raw config.model", () => {
    expect(
      getAgentModelBadge({
        adapterType: "antigravity_local",
        adapterConfig: { model: "Gemini 3.1 Pro (High)" },
      }),
    ).toEqual({
      label: "Antigravity",
      tone: "gemini",
      title: "Antigravity",
    });
  });

  it("keeps raw configured model titles for other adapters", () => {
    expect(
      getAgentModelBadge({
        adapterType: "gemini_local",
        adapterConfig: { model: "gemini-3.5-flash" },
      }),
    ).toEqual({
      label: "Gemini",
      tone: "gemini",
      title: "gemini-3.5-flash",
    });
  });
});

describe("getAgentRegistryLaneRole", () => {
  it("returns null when there is no registry membership", () => {
    expect(getAgentRegistryLaneRole({ id: "a" })).toBeNull();
    expect(getAgentRegistryLaneRole({ id: "a", lanePrimaryAgentId: null })).toBeNull();
  });

  it("returns primary when an agent points at itself", () => {
    expect(getAgentRegistryLaneRole({ id: "a", lanePrimaryAgentId: "a" })).toBe("primary");
  });

  it("returns sister when an agent points at a different primary", () => {
    expect(getAgentRegistryLaneRole({ id: "b", lanePrimaryAgentId: "a" })).toBe("sister");
  });
});

describe("groupAgentFallbackLanesWithRegistry", () => {
  it("falls back to the name heuristic when no agent has registry rows", () => {
    const agents = [
      { id: "1", name: "GLaD0S-Grok" },
      { id: "2", name: "Astra" },
      { id: "3", name: "GLaD0S" },
      { id: "4", name: "GLaD0S-Codex" },
    ];
    const grouped = groupAgentFallbackLanesWithRegistry(agents).map((a) => a.name);
    expect(grouped).toEqual(["Astra", "GLaD0S", "GLaD0S-Grok", "GLaD0S-Codex"]);
  });

  it("groups registry sisters under their registered primary (a -Codex primary)", () => {
    // Registry: codex agent is PRIMARY; claude + hermes agents are sisters.
    const agents = [
      { id: "claude", name: "CEO", lanePrimaryAgentId: "codex" },
      { id: "hermes", name: "CEO-Hermes", lanePrimaryAgentId: "codex" },
      { id: "codex", name: "CEO-Codex", lanePrimaryAgentId: "codex" },
      { id: "other", name: "Standalone" },
    ];
    const grouped = groupAgentFallbackLanesWithRegistry(agents);
    expect(grouped.map((a) => a.id)).toEqual(["codex", "claude", "hermes", "other"]);
    // The codex agent is the registered primary.
    expect(getAgentRegistryLaneRole(grouped[0])).toBe("primary");
    expect(getAgentRegistryLaneRole(grouped[1])).toBe("sister");
    expect(getAgentRegistryLaneRole(grouped[2])).toBe("sister");
  });

  it("keeps registry sisters in place when their primary is absent", () => {
    const agents = [
      { id: "sister", name: "CEO", lanePrimaryAgentId: "missing" },
      { id: "other", name: "Standalone" },
    ];
    const grouped = groupAgentFallbackLanesWithRegistry(agents).map((a) => a.id);
    expect(grouped).toEqual(["sister", "other"]);
  });

  it("lets registry lanes and name-based lanes coexist", () => {
    const agents = [
      // Registry lane
      { id: "claude", name: "CEO", lanePrimaryAgentId: "codex" },
      { id: "codex", name: "CEO-Codex", lanePrimaryAgentId: "codex" },
      // Name-based lane (no registry rows)
      { id: "astra", name: "Astra" },
      { id: "astraCodex", name: "Astra-Codex" },
    ];
    const grouped = groupAgentFallbackLanesWithRegistry(agents).map((a) => a.id);
    expect(grouped).toEqual(["codex", "claude", "astra", "astraCodex"]);
  });
});
