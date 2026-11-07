import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "@/i18n/catalogs/en/work.json";
import zh from "@/i18n/catalogs/zh-CN/work.json";

const pages = [
  "Issues", "MyIssues", "IssueDetail", "Inbox", "LegacyInbox", "CoordinatorTasks",
  "Search", "Projects", "ProjectDetail", "ProjectWorkspaceDetail", "Workspaces",
  "ExecutionWorkspaceDetail", "Goals", "GoalDetail", "Cases", "CaseDetail", "Routines",
  "RoutineDetail", "Routines.production", "RoutineDetail.production", "Approvals",
  "ApprovalDetail", "Costs", "Timeline", "Artifacts", "WhatNeedsMe", "DecisionQueuePage",
];

function flatten(value: unknown, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof item === "string") result.set(path, item);
    else for (const [nestedKey, nestedValue] of flatten(item, path)) result.set(nestedKey, nestedValue);
  }
  return result;
}

describe("work page localization callsites", () => {
  const english = flatten(en);
  const chinese = flatten(zh);
  for (const page of pages) {
    it(`${page} subscribes to the work namespace and references existing static messages`, () => {
      const source = readFileSync(new URL(`./${page}.tsx`, import.meta.url), "utf8");
      expect(source).toContain('useTranslation("work")');
      const keys = [...source.matchAll(/(?:\bt\(|i18nKey=)["']work:([^"']+)["']/g)].map(match => match[1]);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const resolvedKey = english.has(key) ? key : `${key}_other`;
        expect(english.has(resolvedKey), `${page}: ${key}`).toBe(true);
        expect(chinese.has(resolvedKey), `${page}: ${key}`).toBe(true);
      }
      expect(source).not.toMatch(/(?:entityType|scopeKind|viewStateKey|previewMode|missingBehavior|aria-live|data-page)=\{t\(/);
    });
  }
  it("keeps executable examples and API-facing enum values intact", () => {
    const source = readFileSync(new URL("./ProjectWorkspaceDetail.tsx", import.meta.url), "utf8");
    expect(source).toContain('placeholder="pnpm install && pnpm dev"');
    expect(source).toContain('placeholder="pkill -f vite || true"');
    expect(source).toContain('\\"reuseScope\\": \\"project_workspace\\"');
    const project = readFileSync(new URL("./ProjectDetail.tsx", import.meta.url), "utf8");
    expect(project).toContain('scopeKind="project"');
    expect(project).toContain('entityType="project"');
  });
});
