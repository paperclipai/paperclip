import { describe, expect, it } from "vitest";
import {
  AGENT_GRAPH_MAX_STICKIES,
  UI_LAYOUT_MAX_BYTES,
  parseUiLayoutForSurface,
  resolveAgentGraphLayout,
  resolveDashboardLayout,
} from "./ui-layouts.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function graphLayout(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    direction: "TB",
    viewport: { x: 0, y: 0, zoom: 1 },
    positions: { [AGENT_ID]: { x: 10, y: 20 } },
    hiddenAgentIds: [],
    stickies: [],
    drafts: [],
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1",
    x: 0,
    y: 0,
    name: "Copy of Engineer",
    role: "engineer",
    title: null,
    capabilities: null,
    adapterType: "claude_local",
    model: null,
    reportsTo: null,
    sourceAgentId: AGENT_ID,
    ...overrides,
  };
}

describe("agent graph layout validation", () => {
  it("accepts a current layout", () => {
    expect(parseUiLayoutForSurface("agent_graph", graphLayout()).ok).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    const parsed = parseUiLayoutForSurface("agent_graph", graphLayout({ adapterConfig: { env: { API_KEY: "x" } } }));
    expect(parsed.ok).toBe(false);
  });

  it("rejects hire drafts that carry fields outside the allowlist", () => {
    const withConfig = graphLayout({ drafts: [draft({ adapterConfig: { env: { OPENAI_API_KEY: "sk-test" } } })] });
    const withEnv = graphLayout({ drafts: [draft({ env: { TOKEN: "secret" } })] });
    expect(parseUiLayoutForSurface("agent_graph", withConfig).ok).toBe(false);
    expect(parseUiLayoutForSurface("agent_graph", withEnv).ok).toBe(false);
    expect(parseUiLayoutForSurface("agent_graph", graphLayout({ drafts: [draft()] })).ok).toBe(true);
  });

  it("rejects position keys that are not agent ids", () => {
    expect(parseUiLayoutForSurface("agent_graph", graphLayout({ positions: { nope: { x: 0, y: 0 } } })).ok).toBe(false);
  });

  it("rejects too many stickies and non-finite coordinates", () => {
    const sticky = { id: "s", x: 0, y: 0, width: 200, height: 120, text: "", color: "yellow" };
    const stickies = Array.from({ length: AGENT_GRAPH_MAX_STICKIES + 1 }, (_, index) => ({ ...sticky, id: `s${index}` }));
    expect(parseUiLayoutForSurface("agent_graph", graphLayout({ stickies })).ok).toBe(false);
    expect(parseUiLayoutForSurface("agent_graph", graphLayout({ viewport: { x: Number.NaN, y: 0, zoom: 1 } })).ok).toBe(false);
  });

  it("rejects a layout above the byte limit", () => {
    const sticky = { id: "s", x: 0, y: 0, width: 200, height: 120, text: "x".repeat(2_000), color: "yellow" };
    const stickies = Array.from({ length: 200 }, (_, index) => ({ ...sticky, id: `s${index}` }));
    const parsed = parseUiLayoutForSurface("agent_graph", graphLayout({ stickies }));
    expect(JSON.stringify(graphLayout({ stickies })).length).toBeGreaterThan(UI_LAYOUT_MAX_BYTES);
    expect(parsed).toEqual({ ok: false, error: `Layout exceeds ${UI_LAYOUT_MAX_BYTES} bytes` });
  });
});

describe("layout schema migration", () => {
  it("migrates an unversioned agent graph layout to the current version", () => {
    const resolved = resolveAgentGraphLayout({ direction: "LR", positions: { [AGENT_ID]: { x: 1, y: 2 } } });
    expect(resolved).toEqual({
      schemaVersion: 1,
      direction: "LR",
      viewport: null,
      positions: { [AGENT_ID]: { x: 1, y: 2 } },
      hiddenAgentIds: [],
      stickies: [],
      drafts: [],
    });
  });

  it("returns null for layouts from a newer version or with invalid content", () => {
    expect(resolveAgentGraphLayout(graphLayout({ schemaVersion: 99 }))).toBeNull();
    expect(resolveAgentGraphLayout(graphLayout({ direction: "diagonal" }))).toBeNull();
    expect(resolveAgentGraphLayout(null)).toBeNull();
    expect(resolveAgentGraphLayout("layout")).toBeNull();
    expect(resolveAgentGraphLayout([])).toBeNull();
  });

  it("migrates an unversioned dashboard layout and keeps a current one", () => {
    const widgets = [{ instanceId: "a", widgetId: "metric-agents", w: 1, h: 1 }];
    expect(resolveDashboardLayout({ widgets })).toEqual({ schemaVersion: 1, widgets, contextualRules: {} });
    const current = { schemaVersion: 1, widgets, contextualRules: { "live-runs": false } };
    expect(resolveDashboardLayout(current)).toEqual(current);
  });

  it("returns null for an invalid dashboard layout", () => {
    const duplicate = [
      { instanceId: "a", widgetId: "metric-agents", w: 1, h: 1 },
      { instanceId: "a", widgetId: "metric-tasks", w: 1, h: 1 },
    ];
    expect(resolveDashboardLayout({ schemaVersion: 1, widgets: duplicate, contextualRules: {} })).toBeNull();
    expect(resolveDashboardLayout({ schemaVersion: 1, widgets: [{ instanceId: "a", widgetId: "x", w: 9, h: 1 }], contextualRules: {} })).toBeNull();
  });
});
