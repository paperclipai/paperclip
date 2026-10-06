import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";

vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({
  getExperimental: async () => ({ enableIsolatedWorkspaces: true }),
}) }));

// Actual canonical writer and workspace validators. Synthetic rows; no SQL/DB.
function fixture(owned: boolean, kind: "project" | "execution", derive: boolean, invalid?: "missing" | "company" | "project") {
  let row: any = { id: "issue-1", companyId: "company-1", status: "todo", title: "Work",
    assigneeAgentId: null, assigneeUserId: null, parentId: null, projectId: derive ? null : "project-1",
    projectWorkspaceId: null, executionWorkspaceId: null, goalId: null,
    conversationAgentId: null, originKind: "manual", statusVersion: 1 };
  const workspace = { id: "workspace-1", companyId: invalid === "company" ? "company-2" : "company-1",
    projectId: invalid === "project" ? "project-2" : "project-1" };
  const tableName = kind === "project" ? "project_workspaces" : "execution_workspaces";
  const events: string[] = [];
  const predicates: Array<{ table: string; params: unknown[] }> = [];
  const writes: any[] = [];
  function query(rows: unknown[], table?: string) {
    const q: any = { where: (predicate: SQL) => {
      if (table) predicates.push({ table, params: new PgDialect().sqlToQuery(predicate).params });
      return q;
    }, for: () => q, limit: () => q, orderBy: () => q, returning: () => q,
      innerJoin: () => q, leftJoin: () => q,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const tx: any = {
    execute: async () => { events.push("fence"); return []; },
    transaction: () => { throw new Error("nested-transaction"); },
    select: () => ({ from: (table: any) => {
      const name = getTableName(table); events.push(`tx:${name}`);
      if (name === "issues") return query([{ ...row }], name);
      if (name === tableName) return query(invalid === "missing" ? [] : [{ ...workspace }], name);
      if (["goals", "projects", "issue_labels", "labels", "issue_watchdogs"].includes(name)) return query([], name);
      throw new Error(`unmodeled-tx-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: () => {
      expect(getTableName(table)).toBe("issues"); writes.push({ ...patch }); row = { ...row, ...patch }; return query([{ ...row }]);
    } }) }),
  };
  const root: any = {
    select: () => ({ from: (table: any) => { throw new Error(`root-read:${getTableName(table)}`); } }),
    transaction: vi.fn(async (callback: any) => callback(tx)),
  };
  const field = kind === "project" ? "projectWorkspaceId" : "executionWorkspaceId";
  return { events, predicates, writes, root, getRow: () => ({ ...row }),
    run: () => issueService(root).update("issue-1", { companyGuard: "company-1", title: "Edited", [field]: "workspace-1" },
      owned ? root : tx, [], [], { lifecycleFence: true }), tableName, field };
}

describe("dark canonical workspace validation uses preparation executor (recording only)", () => {
  for (const kind of ["project", "execution"] as const) {
    for (const derive of [false, true]) {
      it.each([false, true])(`${kind} workspace derive=${derive} uses fenced executor (owned=%s)`, async (owned) => {
        const f = fixture(owned, kind, derive);
        await expect(f.run()).resolves.toMatchObject({ title: "Edited", projectId: "project-1", [f.field]: "workspace-1" });
        expect(f.events.indexOf("fence")).toBeLessThan(f.events.indexOf(`tx:${f.tableName}`));
        expect(f.predicates.filter((p) => p.table === f.tableName)).toEqual([{ table: f.tableName, params: ["workspace-1"] }]);
        expect(f.writes).toHaveLength(1);
        expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
      });
    }
    for (const invalid of ["missing", "company", "project"] as const) {
      it.each([false, true])(`${kind} workspace rejects ${invalid} without writes (owned=%s)`, async (owned) => {
        const f = fixture(owned, kind, false, invalid);
        const prefix = kind === "project" ? "Project" : "Execution";
        await expect(f.run()).rejects.toThrow(invalid === "missing" ? `${prefix} workspace not found` :
          invalid === "company" ? `${prefix} workspace must belong to same company` : `${prefix} workspace must belong to the selected project`);
        expect(f.writes).toEqual([]);
        expect(f.getRow().title).toBe("Work");
      });
    }
  }
});
