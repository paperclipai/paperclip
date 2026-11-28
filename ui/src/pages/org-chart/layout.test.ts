import { describe, expect, it } from "vitest";
import { layoutOrganization, routeReportingEdges, type LayoutNode, type ChartGeometry } from "./layout";
import type { OrgNode } from "../../api/agents";
const geometry: ChartGeometry = { leaderWidth: 280, leaderHeight: 368, managerWidth: 232, managerHeight: 320, memberWidth: 192, memberHeight: 116, gap: 32, levelGap: 72, padding: 48, taskHeight: 32, sparsePadding: 80, fitZoomMax: 1.25, sparseFitZoomMax: 1 };
const node = (id: string, reports: OrgNode[] = []): OrgNode => ({ id, name: id, role: "general", status: "idle", reports });
function flatten(roots: LayoutNode[]): LayoutNode[] { return roots.flatMap(root => [root, ...flatten(root.children)]); }
describe("compact organization layout", () => {
  it("wraps broad teams, cascades leaders, and keeps every card separate", () => {
    const tree = [node("ceo", [node("cto", Array.from({ length: 12 }, (_, i) => node(`eng-${i}`))), node("cmo", Array.from({ length: 4 }, (_, i) => node(`mkt-${i}`))), node("staff")])];
    for (const viewport of [{ width: 1500, height: 900 }, { width: 390, height: 750 }]) {
      const result = layoutOrganization(tree, viewport, geometry);
      const nodes = flatten(result.roots);
      expect(nodes).toHaveLength(20);
      expect(nodes[0].width).toBeGreaterThan(nodes[1].width);
      expect(nodes[1].height).toBeGreaterThan(nodes[2].height);
      expect(new Set(nodes.filter(n => n.id.startsWith("eng-")).map(n => n.y)).size).toBeGreaterThan(1);
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
      const scale = Math.min(viewport.width / result.width, viewport.height / result.height);
      expect(result.height * scale).toBeGreaterThan(viewport.height * 0.65);
    }
  });
  it("keeps a mixed team's ICs beside its leaders", () => {
    const tree = [node("ceo", [
      node("cto", Array.from({ length: 12 }, (_, i) => node(`eng-${i}`))),
      node("cmo", Array.from({ length: 4 }, (_, i) => node(`mkt-${i}`))),
      ...Array.from({ length: 4 }, (_, i) => node(`staff-${i}`)),
    ])];
    const result = layoutOrganization(tree, { width: 1500, height: 900 }, geometry);
    const nodes = flatten(result.roots);
    const cto = nodes.find(n => n.id === "cto")!;
    expect(nodes.find(n => n.id === "staff-0")!.y).toBe(cto.y);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const aBottom = a.y + a.height;
      const bBottom = b.y + b.height;
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || aBottom <= b.y || bBottom <= a.y).toBe(true);
    }
  });
  it("routes broad and stacked teams with separate orthogonal tracks outside cards", () => {
    const tree = [node("ceo", [node("cmo", Array.from({ length: 4 }, (_, i) => node(`mkt-${i}`))), node("cto", Array.from({ length: 12 }, (_, i) => node(`eng-${i}`))), ...Array.from({ length: 4 }, (_, i) => node(`staff-${i}`))])];
    for (const viewport of [{ width: 1500, height: 900 }, { width: 390, height: 750 }]) {
      const result = layoutOrganization(tree, viewport, geometry);
      const nodes = flatten(result.roots);
      const routes = routeReportingEdges(result.roots, geometry.gap);
      expect(routes).toHaveLength(nodes.length - 1);
      const segments = routes.flatMap(route => route.points.slice(1).map((end, i) => ({ start: route.points[i], end })));
      for (const segment of segments) {
        const { start: a, end: b } = segment;
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const card of nodes) {
          const inside = a.x === b.x
            ? a.x > card.x && a.x < card.x + card.width && Math.max(a.y, b.y) > card.y && Math.min(a.y, b.y) < card.y + card.height
            : a.y > card.y && a.y < card.y + card.height && Math.max(a.x, b.x) > card.x && Math.min(a.x, b.x) < card.x + card.width;
          expect(inside, `Line crosses ${card.id}`).toBe(false);
        }
      }
      for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i], b = segments[j];
        const vertical = a.start.x === a.end.x && b.start.x === b.end.x;
        const horizontal = a.start.y === a.end.y && b.start.y === b.end.y;
        const overlap = vertical && a.start.x === b.start.x
          ? Math.min(Math.max(a.start.y, a.end.y), Math.max(b.start.y, b.end.y)) > Math.max(Math.min(a.start.y, a.end.y), Math.min(b.start.y, b.end.y))
          : horizontal && a.start.y === b.start.y && Math.min(Math.max(a.start.x, a.end.x), Math.max(b.start.x, b.end.x)) > Math.max(Math.min(a.start.x, a.end.x), Math.min(b.start.x, b.end.x));
        expect(overlap, `Shared line segments ${i} and ${j}`).toBe(false);
      }
    }
  });
  it("uses exactly three stable tiers, including deeper leads and root-level contributors", () => {
    const tree = [node("ceo", [node("cto", [node("team-lead", [node("engineer")])]), node("staff")]), node("independent")];
    for (const viewport of [{ width: 1500, height: 900 }, { width: 2400, height: 1600 }, { width: 390, height: 750 }]) {
      const nodes = new Map(flatten(layoutOrganization(tree, viewport, geometry).roots).map(n => [n.id, n]));
      expect(nodes.get("ceo")).toMatchObject({ tier: 1, width: geometry.leaderWidth, height: geometry.leaderHeight });
      for (const id of ["cto", "team-lead"]) expect(nodes.get(id)).toMatchObject({ tier: 2, width: geometry.managerWidth, height: geometry.managerHeight });
      for (const id of ["engineer", "staff", "independent"]) expect(nodes.get(id)).toMatchObject({ tier: 3, width: geometry.memberWidth, height: geometry.memberHeight });
      for (const leader of [...nodes.values()].filter(n => n.leader)) expect(leader.height).toBeGreaterThan(leader.width);
    }
  });
  it("caps sparse organizations at natural size with generous, symmetric padding", () => {
    for (const tree of [[node("solo")], [node("lead", [node("report")])], [node("first"), node("second")]]) {
      const result = layoutOrganization(tree, { width: 2400, height: 1600 }, geometry);
      const nodes = flatten(result.roots);
      expect(result.maxFitZoom).toBe(1);
      expect(Math.min(...nodes.map(n => n.x))).toBe(geometry.sparsePadding);
      expect(Math.min(...nodes.map(n => n.y))).toBe(geometry.sparsePadding);
      expect(result.width - Math.max(...nodes.map(n => n.x + n.width))).toBe(geometry.sparsePadding);
      expect(result.height - Math.max(...nodes.map(n => n.y + n.height))).toBe(geometry.sparsePadding);
      expect(nodes[0].width).toBe(nodes[0].leader ? geometry.leaderWidth : geometry.memberWidth);
    }
  });
  it("handles a large roster without revisiting source subtrees quadratically", () => {
    let reads = 0;
    const root = node("root", Array.from({ length: 500 }, (_, i) => node(`agent-${i}`)));
    const reports = root.reports;
    Object.defineProperty(root, "reports", { get: () => { reads++; if (reads > 30) throw new Error("Repeated subtree scan"); return reports; } });
    const result = layoutOrganization([root], { width: 1500, height: 900 }, geometry);
    expect(flatten(result.roots)).toHaveLength(501);
    expect(reads).toBeLessThanOrEqual(18);
  });
});
