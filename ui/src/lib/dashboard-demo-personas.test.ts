import { describe, expect, it } from "vitest";
import { dashboardDemoPersonas, parseDashboardDemoPersona } from "./dashboard-demo-personas";

const company = (id: string, description: string | null, createdAt: string, status = "active") =>
  ({ id, issuePrefix: id.toUpperCase(), description, createdAt: new Date(createdAt), status }) as Parameters<typeof dashboardDemoPersonas>[0][number];

describe("parseDashboardDemoPersona", () => {
  it("reads the name and role after the marker", () => {
    expect(parseDashboardDemoPersona("[dashboard-demo] Scott — Chief Product Officer")).toEqual({ name: "Scott", role: "Chief Product Officer" });
    expect(parseDashboardDemoPersona("[dashboard-demo] Dotta — CEO and engineer\nMore about the company.")).toEqual({ name: "Dotta", role: "CEO and engineer" });
    expect(parseDashboardDemoPersona("[dashboard-demo] Tom")).toEqual({ name: "Tom", role: null });
  });

  it("ignores descriptions without the marker at the start", () => {
    expect(parseDashboardDemoPersona("A demo company")).toBeNull();
    expect(parseDashboardDemoPersona("About us: [dashboard-demo] Scott — CPO")).toBeNull();
    expect(parseDashboardDemoPersona("[dashboard-demo]   ")).toBeNull();
    expect(parseDashboardDemoPersona(null)).toBeNull();
  });
});

describe("dashboardDemoPersonas", () => {
  it("lists the marked organizations in the order they were created, leaving out archived ones", () => {
    const personas = dashboardDemoPersonas([
      company("tom", "[dashboard-demo] Tom — Investor", "2026-11-03"),
      company("demo", "Demo Co", "2026-01-01"),
      company("scott", "[dashboard-demo] Scott — Chief Product Officer", "2026-11-01"),
      company("old", "[dashboard-demo] Old — Gone", "2026-10-01", "archived"),
      company("dotta", "[dashboard-demo] Dotta — CEO and engineer", "2026-11-02"),
    ]);
    expect(personas.map((persona) => [persona.issuePrefix, persona.name, persona.role])).toEqual([
      ["SCOTT", "Scott", "Chief Product Officer"],
      ["DOTTA", "Dotta", "CEO and engineer"],
      ["TOM", "Tom", "Investor"],
    ]);
  });
});
