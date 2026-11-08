import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import en from "../i18n/catalogs/en/final-pages.json";
import zh from "../i18n/catalogs/zh-CN/final-pages.json";
it("keeps the new namespace paired, interpolations intact, and rich components named", () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  const slots = (s: string) => [...s.matchAll(/{{\s*([^}]+?)\s*}}/g)].map(m => m[1]).sort();
  for (const [key, value] of Object.entries(en)) {
    expect(slots(zh[key as keyof typeof zh]), key).toEqual(slots(value));
    expect(value, key).not.toMatch(/<\/?\d+(?:>|\s)/);
    expect(zh[key as keyof typeof zh], key).not.toMatch(/<\/?\d+(?:>|\s)/);
  }
});
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
it("resolves role presentation at render time but preserves canonical search vocabulary", () => {
  for (const path of ["Agents.tsx", "Agents.production.tsx", "AgentDetail.tsx", "AgentDetail.production.tsx", "OrgChart.tsx", "OrgChart.production.tsx"]) {
    const text = source(path);
    expect(text, path).toContain("getAgentRoleLabel");
    expect(text, path).not.toMatch(/roleLabels\[(?:agent|node)\.role\] \?\? (?:agent|node)\.role/);
  }
  expect(source("Agents.tsx")).toContain("agent.role, roleLabels[agent.role], agent.title");
});
it("keeps protocol selector and status props raw", () => {
  expect(source("Cases.tsx")).toContain('record.projectId ?? "none"');
  expect(source("tools/shared.tsx")).toContain('status="quarantined"');
  expect(source("apps/connection-identity.ts")).toContain('const ORGANIZATION_NAME_SUFFIX = " for the organization"');
});
