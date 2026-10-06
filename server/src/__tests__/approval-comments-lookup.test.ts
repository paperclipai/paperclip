import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalComments, approvals } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { approvalService } from "../services/approvals.js";

const hooks = vi.hoisted(() => ({
  settings: vi.fn(),
  redact: vi.fn((body: string, options: { enabled: boolean }) => options.enabled ? "synthetic-redacted" : body),
}));
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ getGeneral: hooks.settings }) }));
vi.mock("../log-redaction.js", () => ({ redactCurrentUserText: hooks.redact }));

// Actual service and Drizzle query expressions; synthetic rows, no SQL/server.
function fixture({ missing = false, readError, storageError }: {
  missing?: boolean; readError?: Error; storageError?: Error;
} = {}) {
  const events: string[] = [];
  const predicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const orders: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const inserted: Record<string, unknown>[] = [];
  const dialect = new PgDialect();
  const approval = { id: "approval-1", companyId: "company-1", type: "hire_agent", status: "rejected" };
  const comment = { id: "comment-1", companyId: "company-1", approvalId: "approval-1", body: "synthetic-body" };
  const db = {
    select: () => ({ from: (table: unknown) => {
      if (table === approvals) return { where: (predicate: any) => {
        events.push("approval-read"); predicates.push(dialect.sqlToQuery(predicate));
        return readError ? Promise.reject(readError) : Promise.resolve(missing ? [] : [approval]);
      } };
      if (table === approvalComments) return { where: (predicate: any) => {
        events.push("comments-read"); predicates.push(dialect.sqlToQuery(predicate));
        return { orderBy: (order: any) => {
          orders.push(dialect.sqlToQuery(order));
          return storageError ? Promise.reject(storageError) : Promise.resolve([comment]);
        } };
      } };
      throw new Error("unexpected-select");
    } }),
    insert: (table: unknown) => {
      expect(table).toBe(approvalComments);
      return { values: (values: Record<string, unknown>) => {
        events.push("comment-insert"); inserted.push(values);
        return { returning: () => storageError ? Promise.reject(storageError) : Promise.resolve([{ ...comment, ...values }]) };
      } };
    },
    update: () => { throw new Error("unexpected-update"); },
    transaction: () => { throw new Error("unexpected-transaction"); },
  };
  hooks.settings.mockImplementation(async () => { events.push("settings"); return { censorUsernameInLogs: true }; });
  return { svc: approvalService(db as any), events, predicates, orders, inserted, comment };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("ordinary approval comment lookup preservation", () => {
  it("lists comments after the ID-only approval lookup, preserving company/order/redaction", async () => {
    const f = fixture();
    const result = await f.svc.listComments("approval-1");
    expect(f.events).toEqual(["approval-read", "settings", "comments-read"]);
    expect(f.predicates[0]).toMatchObject({ sql: '"approvals"."id" = $1', params: ["approval-1"] });
    expect(f.predicates[1].params).toEqual(["approval-1", "company-1"]);
    expect(f.predicates[1].sql).toContain('"approval_comments"."company_id"');
    expect(f.orders[0].sql).toBe('"approval_comments"."created_at" asc');
    expect(result).toEqual([{ ...f.comment, body: "synthetic-redacted" }]);
    expect(f.comment.body).toBe("synthetic-body");
    expect(hooks.redact).toHaveBeenCalledWith("synthetic-body", { enabled: true });
  });

  it.each([{ agentId: "agent-1" }, { userId: "user-1" }, {}])("adds comments preserving actor fields: %j", async (actor: { agentId?: string; userId?: string }) => {
    const f = fixture();
    const result = await f.svc.addComment("approval-1", "synthetic-body", actor);
    expect(f.events).toEqual(["approval-read", "settings", "comment-insert"]);
    expect(f.predicates[0]).toMatchObject({ sql: '"approvals"."id" = $1', params: ["approval-1"] });
    expect(f.inserted).toEqual([{
      companyId: "company-1", approvalId: "approval-1", authorAgentId: actor.agentId ?? null,
      authorUserId: actor.userId ?? null, body: "synthetic-redacted",
    }]);
    expect(result.body).toBe("synthetic-redacted");
    expect(hooks.redact).toHaveBeenCalledTimes(2);
  });

  it.each(["list", "add"] as const)("rejects missing approval before settings or comments: %s", async (method) => {
    const f = fixture({ missing: true });
    const call = method === "list" ? f.svc.listComments("approval-1") : f.svc.addComment("approval-1", "body", {});
    await expect(call).rejects.toMatchObject({ status: 404, message: "Approval not found" });
    expect(f.events).toEqual(["approval-read"]);
    expect(hooks.settings).not.toHaveBeenCalled();
    expect(hooks.redact).not.toHaveBeenCalled();
  });

  it.each(["list", "add"] as const)("propagates approval-read failure without later effects: %s", async (method) => {
    const error = new Error("synthetic-read-error");
    const f = fixture({ readError: error });
    await expect(method === "list" ? f.svc.listComments("approval-1") : f.svc.addComment("approval-1", "body", {})).rejects.toBe(error);
    expect(f.events).toEqual(["approval-read"]);
    expect(hooks.settings).not.toHaveBeenCalled();
  });

  it.each(["list", "add"] as const)("preserves disabled redaction: %s", async (method) => {
    const f = fixture();
    hooks.settings.mockResolvedValue({ censorUsernameInLogs: false });
    const result = method === "list" ? await f.svc.listComments("approval-1") : await f.svc.addComment("approval-1", "synthetic-body", {});
    expect(Array.isArray(result) ? result[0].body : result.body).toBe("synthetic-body");
    expect(hooks.redact).toHaveBeenCalledWith("synthetic-body", { enabled: false });
  });

  it.each(["list", "add"] as const)("propagates settings failure before comment storage: %s", async (method) => {
    const f = fixture();
    const error = new Error("synthetic-settings-error");
    hooks.settings.mockRejectedValue(error);
    await expect(method === "list" ? f.svc.listComments("approval-1") : f.svc.addComment("approval-1", "body", {})).rejects.toBe(error);
    expect(f.events).toEqual(["approval-read"]);
    expect(f.inserted).toEqual([]);
    expect(hooks.redact).not.toHaveBeenCalled();
  });

  it.each(["list", "add"] as const)("propagates comment storage failure: %s", async (method) => {
    const error = new Error("synthetic-storage-error");
    const f = fixture({ storageError: error });
    await expect(method === "list" ? f.svc.listComments("approval-1") : f.svc.addComment("approval-1", "body", {})).rejects.toBe(error);
    expect(f.events).toEqual(["approval-read", "settings", method === "list" ? "comments-read" : "comment-insert"]);
  });
});
