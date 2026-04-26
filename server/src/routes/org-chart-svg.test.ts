import { describe, it, expect } from "vitest";
import {
  renderOrgChartSvg,
  ORG_CHART_STYLES,
  type OrgNode,
  type OrgChartStyle,
} from "./org-chart-svg.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function leafNode(id: string, name: string, role = "engineer"): OrgNode {
  return { id, name, role, status: "active", reports: [] };
}

const SINGLE_NODE: OrgNode[] = [leafNode("ceo-1", "Alice", "ceo")];

const TWO_LEVEL_TREE: OrgNode[] = [
  {
    id: "ceo-1",
    name: "Alice",
    role: "ceo",
    status: "active",
    reports: [
      leafNode("cto-1", "Bob", "cto"),
      leafNode("cfo-1", "Carol", "cfo"),
    ],
  },
];

// ---------------------------------------------------------------------------
// renderOrgChartSvg — output structure
// ---------------------------------------------------------------------------

describe("renderOrgChartSvg output structure", () => {
  it("returns a string", () => {
    expect(typeof renderOrgChartSvg(SINGLE_NODE)).toBe("string");
  });

  it("returns a string that starts with <svg", () => {
    expect(renderOrgChartSvg(SINGLE_NODE).trimStart()).toMatch(/^<svg /);
  });

  it("includes the xmlns attribute", () => {
    expect(renderOrgChartSvg(SINGLE_NODE)).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("closes the svg element at the end", () => {
    const svg = renderOrgChartSvg(SINGLE_NODE);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
  });

  it("includes a width and height attribute", () => {
    const svg = renderOrgChartSvg(SINGLE_NODE);
    expect(svg).toMatch(/width="\d+"/);
    expect(svg).toMatch(/height="\d+"/);
  });
});

// ---------------------------------------------------------------------------
// renderOrgChartSvg — node content
// ---------------------------------------------------------------------------

describe("renderOrgChartSvg node content", () => {
  it("includes the agent name from a single-node tree", () => {
    expect(renderOrgChartSvg(SINGLE_NODE)).toContain("Alice");
  });

  it("includes all agent names from a multi-node tree", () => {
    const svg = renderOrgChartSvg(TWO_LEVEL_TREE);
    expect(svg).toContain("Alice");
    expect(svg).toContain("Bob");
    expect(svg).toContain("Carol");
  });

  it("handles an empty orgTree by rendering a virtual root", () => {
    const svg = renderOrgChartSvg([]);
    expect(svg).toMatch(/^<svg /);
  });

  it("renders a multi-root tree using a virtual root wrapper", () => {
    const multiRoot: OrgNode[] = [
      leafNode("a-1", "Agent A"),
      leafNode("a-2", "Agent B"),
    ];
    const svg = renderOrgChartSvg(multiRoot);
    expect(svg).toContain("Agent A");
    expect(svg).toContain("Agent B");
  });
});

// ---------------------------------------------------------------------------
// renderOrgChartSvg — style variants
// ---------------------------------------------------------------------------

describe("renderOrgChartSvg style variants", () => {
  it("renders successfully for each canonical style", () => {
    for (const style of ORG_CHART_STYLES) {
      const svg = renderOrgChartSvg(SINGLE_NODE, style);
      expect(svg).toMatch(/^<svg /);
    }
  });

  it("defaults to warmth style when style is omitted", () => {
    const svgDefault = renderOrgChartSvg(SINGLE_NODE);
    const svgWarmth = renderOrgChartSvg(SINGLE_NODE, "warmth");
    expect(svgDefault).toBe(svgWarmth);
  });

  it("produces different output for different styles", () => {
    const svgMonochrome = renderOrgChartSvg(SINGLE_NODE, "monochrome");
    const svgNebula = renderOrgChartSvg(SINGLE_NODE, "nebula");
    expect(svgMonochrome).not.toBe(svgNebula);
  });
});

// ---------------------------------------------------------------------------
// renderOrgChartSvg — overlay options
// ---------------------------------------------------------------------------

describe("renderOrgChartSvg overlay options", () => {
  it("includes the companyName in SVG text when provided", () => {
    const svg = renderOrgChartSvg(SINGLE_NODE, "warmth", { companyName: "Acme Corp" });
    expect(svg).toContain("Acme Corp");
  });

  it("includes the stats string in SVG text when provided", () => {
    const svg = renderOrgChartSvg(SINGLE_NODE, "warmth", { stats: "Agents: 3" });
    expect(svg).toContain("Agents: 3");
  });

  it("escapes special characters in companyName", () => {
    const svg = renderOrgChartSvg(SINGLE_NODE, "warmth", { companyName: "A&B <Corp>" });
    expect(svg).toContain("A&amp;B &lt;Corp&gt;");
    expect(svg).not.toContain("A&B <Corp>");
  });

  it("renders without overlay when overlay is omitted", () => {
    const svg = renderOrgChartSvg(SINGLE_NODE, "warmth");
    expect(svg).toMatch(/^<svg /);
  });
});

// ---------------------------------------------------------------------------
// ORG_CHART_STYLES constant
// ---------------------------------------------------------------------------

describe("ORG_CHART_STYLES", () => {
  it("contains exactly 5 style names", () => {
    expect(ORG_CHART_STYLES).toHaveLength(5);
  });

  it("includes monochrome, nebula, circuit, warmth, schematic", () => {
    expect(ORG_CHART_STYLES).toContain("monochrome");
    expect(ORG_CHART_STYLES).toContain("nebula");
    expect(ORG_CHART_STYLES).toContain("circuit");
    expect(ORG_CHART_STYLES).toContain("warmth");
    expect(ORG_CHART_STYLES).toContain("schematic");
  });
});
