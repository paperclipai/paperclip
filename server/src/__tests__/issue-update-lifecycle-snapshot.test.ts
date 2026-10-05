import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";

vi.mock("../services/chat-completion-delivery.js", () => ({ recordChatCompletion: async () => undefined }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({
  getExperimental: async () => ({ enableIsolatedWorkspaces: true }),
}) }));

// Real canonical writer; barrier and query recording only, no SQL or rollback.
function fixture(owned: boolean) {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const fenceEntered = new Promise<void>((resolve) => { entered = resolve; });
  let row: any = { id: "issue-1", companyId: "company-1", status: "todo", title: "Work",
    assigneeAgentId: null, assigneeUserId: null, parentId: null, projectId: "project-1",
    projectWorkspaceId: null, executionWorkspaceId: null, goalId: null,
    conversationAgentId: null, originKind: "manual", statusVersion: 1 };
  const predicates: Array<{ table: string; params: unknown[] }> = [];
  const writes: any[] = [];
  function query(rows: unknown[], table: string) {
    const q: any = { where: (predicate: SQL) => {
      predicates.push({ table, params: new PgDialect().sqlToQuery(predicate).params }); return q;
    }, for: () => q, limit: () => q, orderBy: () => q, returning: () => q,
      innerJoin: () => q, leftJoin: () => q,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject) };
    return q;
  }
  const tx: any = {
    execute: async () => { entered(); await barrier; return []; },
    transaction: () => { throw new Error("nested-transaction"); },
    select: () => ({ from: (table: any) => {
      const name = getTableName(table);
      if (name === "issues") return query([{ ...row }], name);
      if (name === "project_workspaces") return query([{ id: "workspace-1", companyId: "company-1", projectId: "project-1" }], name);
      if (["goals", "projects", "issue_labels", "labels", "issue_watchdogs"].includes(name)) return query([], name);
      throw new Error(`unmodeled-tx-read:${name}`);
    } }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (predicate: SQL) => {
      expect(getTableName(table)).toBe("issues");
      predicates.push({ table: "issue-write", params: new PgDialect().sqlToQuery(predicate).params });
      writes.push({ ...patch }); row = { ...row, ...patch }; return query([{ ...row }], "issues");
    } }) }),
  };
  const root: any = {
    select: () => ({ from: (table: any) => { throw new Error(`root-read:${getTableName(table)}`); } }),
    transaction: vi.fn(async (callback: any) => callback(tx)),
  };
  const data: any = { companyGuard: "company-1", title: "Requested", projectWorkspaceId: "workspace-1",
    executionPolicy: { monitor: { kind: "external", reason: "requested", delays: [10, 20] } } };
  const options = { lifecycleFence: true };
  return { data, options, writes, predicates, root, release, fenceEntered,
    run: () => issueService(root).update("issue-1", data, owned ? root : tx, [], [], options) };
}

describe("dark canonical invocation snapshots (recording, not authorization)", () => {
  it.each([false, true])("captures routing and opt-in before a suspended fence (owned=%s)", async (owned) => {
    const f = fixture(owned);
    const result = f.run();
    await f.fenceEntered;
    expect(f.writes).toEqual([]);
    f.data.companyGuard = "company-2";
    f.data.title = "Retargeted";
    f.data.projectWorkspaceId = "workspace-2";
    f.release();
    await expect(result).resolves.toMatchObject({ title: "Requested", projectWorkspaceId: "workspace-1" });
    expect(f.predicates.filter((p) => p.table === "issues" || p.table === "issue-write")).toEqual([
      { table: "issues", params: ["issue-1", "company-1"] },
      { table: "issues", params: ["issue-1", "company-1"] },
      { table: "issue-write", params: ["issue-1", "company-1"] },
    ]);
    expect(f.predicates.filter((p) => p.table === "project_workspaces")).toEqual([
      { table: "project_workspaces", params: ["workspace-1"] },
    ]);
    expect(f.writes).toHaveLength(1);
    expect(f.root.transaction).toHaveBeenCalledTimes(owned ? 1 : 0);
  });

  it.each([false, true])("retains opt-in routing when caller mutates options (owned=%s)", async (owned) => {
    const f = fixture(owned);
    const result = f.run();
    await f.fenceEntered;
    f.options.lifecycleFence = false;
    f.release();
    await expect(result).resolves.toMatchObject({ projectWorkspaceId: "workspace-1" });
    expect(f.writes).toHaveLength(1);
  });

  it.each([false, true])("detaches nested patch objects and arrays before await (owned=%s)", async (owned) => {
    const f = fixture(owned);
    const result = f.run();
    await f.fenceEntered;
    f.data.executionPolicy.monitor.reason = "mutated";
    f.data.executionPolicy.monitor.delays.push(30);
    f.release();
    await expect(result).resolves.toMatchObject({ executionPolicy: {
      monitor: { kind: "external", reason: "requested", delays: [10, 20] },
    } });
    expect(f.writes[0].executionPolicy).not.toBe(f.data.executionPolicy);
    expect(f.data.executionPolicy.monitor.delays).toEqual([10, 20, 30]);
  });
});
