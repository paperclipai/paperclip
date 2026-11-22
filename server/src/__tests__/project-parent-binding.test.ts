import { describe, expect, it } from "vitest";
import { assertProjectParentBinding, type ProjectParentLookup } from "../services/projects.js";

type Row = { id: string; companyId: string; archivedAt: Date | null; parentProjectId: string | null };

function lookup(rows: Row[]): ProjectParentLookup {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return async (projectId) => byId.get(projectId) ?? null;
}

const companyId = "company-1";
const row = (id: string, parentProjectId: string | null = null, extra: Partial<Row> = {}): Row =>
  ({ id, companyId, archivedAt: null, parentProjectId, ...extra });

describe("assertProjectParentBinding", () => {
  it("accepts an empty parent and a parent in the same company", async () => {
    await expect(assertProjectParentBinding({
      companyId, projectId: "p2", parentProjectId: null, lookup: lookup([row("p1")]),
    })).resolves.toBeUndefined();
    await expect(assertProjectParentBinding({
      companyId, projectId: "p2", parentProjectId: "p1", lookup: lookup([row("p1")]),
    })).resolves.toBeUndefined();
  });

  it("rejects a project as its own parent", async () => {
    await expect(assertProjectParentBinding({
      companyId, projectId: "p1", parentProjectId: "p1", lookup: lookup([row("p1")]),
    })).rejects.toThrow(/own parent/);
  });

  it("rejects a parent from another company", async () => {
    await expect(assertProjectParentBinding({
      companyId, projectId: "p2", parentProjectId: "p1",
      lookup: lookup([row("p1", null, { companyId: "company-2" })]),
    })).rejects.toThrow(/same company/);
  });

  it("rejects a missing or archived parent", async () => {
    await expect(assertProjectParentBinding({
      companyId, projectId: "p2", parentProjectId: "missing", lookup: lookup([]),
    })).rejects.toThrow(/not found/);
    await expect(assertProjectParentBinding({
      companyId, projectId: "p2", parentProjectId: "p1",
      lookup: lookup([row("p1", null, { archivedAt: new Date() })]),
    })).rejects.toThrow(/archived/);
  });

  it("rejects a link that would put a project under its own descendant", async () => {
    // p3 -> p2 -> p1 (p3 is the root; p1 currently has no parent).
    const rows = [row("p1", "p2"), row("p2", "p3"), row("p3")];
    await expect(assertProjectParentBinding({
      companyId, projectId: "p3", parentProjectId: "p2", lookup: lookup(rows),
    })).rejects.toThrow(/cycle/);
  });

  it("rejects an existing cycle further up the chain", async () => {
    const rows = [row("p2", "p3"), row("p3", "p2")];
    await expect(assertProjectParentBinding({
      companyId, projectId: "p4", parentProjectId: "p2", lookup: lookup(rows),
    })).rejects.toThrow(/cycle/);
  });
});
