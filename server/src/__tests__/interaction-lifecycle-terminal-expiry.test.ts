import { describe, expect, it, vi } from "vitest";
import { issues, issueThreadInteractions, toolActionRequests, toolOauthStates } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import * as service from "../services/issue-thread-interactions.js";
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/chat-interaction-publications.js", () => ({
  enqueueTerminalIssueInteractionChatPublications: async (_tx: unknown, row: any) => { publications.push(row.id); },
}));
const publications: string[] = [];
function fixture(config: { status?: string; missing?: boolean; empty?: boolean; noResult?: boolean; writeError?: Error } = {}) {
  publications.length = 0;
  const dialect = new PgDialect(); const events: string[] = []; const queries: any[] = []; const patches: any[] = [];
  let release!: () => void; let reject!: (e: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const row = { id: "interaction-1", companyId: "company-1", issueId: "issue-1", kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Confirm offline fixture" }, result: null };
  const tx: any = {
    transaction: () => { throw new Error("nested-transaction"); },
    execute: async (q: any) => { events.push("fence"); expect(dialect.sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    select: () => ({ from: (table: unknown) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q));
      if (table === issues) return { for: async (mode: string) => { expect(mode).toBe("update"); events.push("issue-read"); return config.missing ? [] : [{ id: "issue-1", companyId: "company-1", status: config.status ?? "done" }]; } };
      expect(table).toBe(issueThreadInteractions); events.push("pending-read"); return Promise.resolve(config.empty ? [] : [row]);
    } }) }),
    update: (table: unknown) => ({ set: (patch: any) => ({ where: (q: any) => {
      if (table === issues) { events.push("touch"); return Promise.resolve(); }
      queries.push(dialect.sqlToQuery(q)); patches.push({ table, patch });
      if (table === toolActionRequests) { events.push("tool-expiry"); return Promise.resolve(); }
      expect(table).toBe(issueThreadInteractions); events.push("card-expiry"); return { returning: async () => {
        if (config.writeError) throw config.writeError;
        return config.noResult ? [] : [{ ...row, ...patch }];
      } };
    } }) }),
    delete: (table: unknown) => { expect(table).toBe(toolOauthStates); throw new Error("unexpected-oauth-delete"); },
  };
  const root: any = { ...tx, transaction: async (cb: any) => { events.push("legacy-tx"); return cb(tx); } };
  return { root, tx, events, queries, patches, release, reject };
}
const invoke = (f: ReturnType<typeof fixture>, issue = { id: "issue-1", companyId: "company-1" }, actor = { userId: "user-1" }) =>
  (service as any).expirePendingInteractionsForTerminalIssueInTransaction(f.tx, issue, actor, { postCommitPublications: [] });
describe("dark supplied terminal interaction expiry recording", () => {
  it("fences before authoritative terminal read and canonical tool/card expiry", async () => {
    const f = fixture();
    const pending = Promise.resolve().then(() => invoke(f)); void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["fence"]); expect(f.queries).toEqual([]); }
    finally { f.release(); }
    const rows = await pending;
    expect(f.events).toEqual(["fence", "issue-read", "pending-read", "tool-expiry", "card-expiry"]);
    expect(rows[0]).toMatchObject({ id: "interaction-1", status: "expired", resolvedByUserId: "user-1" });
    expect(publications).toEqual(["interaction-1"]);
    expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
    expect(f.queries[1].params).toEqual(["company-1", "issue-1", "pending"]);
    expect(f.queries[3].params).toEqual(["interaction-1", "pending", "company-1", "issue-1"]);
  });
  for (const status of ["todo", "in_progress", "blocked", "in_review"]) {
    it(`does not expire pending human gates on authoritative ${status}`, async () => {
      const f = fixture({ status }); f.release(); await expect(invoke(f)).resolves.toEqual([]);
      expect(f.events).toEqual(["fence", "issue-read"]); expect(f.patches).toEqual([]);
    });
  }
  for (const status of ["done", "cancelled"]) {
    it(`expires gates on authoritative ${status}`, async () => {
      const f = fixture({ status }); f.release(); const rows = await invoke(f);
      expect(rows[0].status).toBe("expired");
    });
  }
  it("captures routing and actor before fence suspension", async () => {
    const f = fixture(); const issue = { id: "issue-1", companyId: "company-1" }; const actor = { userId: "user-1" };
    const pending = invoke(f, issue, actor); Object.assign(issue, { id: "other", companyId: "foreign" }); actor.userId = "other";
    f.release(); await pending; expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
    expect(f.patches[1].patch.resolvedByUserId).toBe("user-1"); expect(f.patches[0].patch.resolvedByUserId).toBe("user-1");
  });
  it("rejects missing company before effects", async () => {
    const f = fixture(); await expect(invoke(f, { id: "issue-1", companyId: "" })).rejects.toMatchObject({ status: 422 });
    expect(f.events).toEqual([]);
  });
  it("rejects fence before reads or writes", async () => {
    const f = fixture(); const error = new Error("fence-denied"); const assertion = expect(invoke(f)).rejects.toBe(error);
    f.reject(error); await assertion; expect(f.queries).toEqual([]); expect(f.patches).toEqual([]);
  });
  it("rejects missing authoritative issue", async () => {
    const f = fixture({ missing: true }); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 404 });
    expect(f.events).toEqual(["fence", "issue-read"]);
  });
  it("returns empty pending set without writes", async () => {
    const f = fixture({ empty: true }); f.release(); await expect(invoke(f)).resolves.toEqual([]);
    expect(f.patches).toEqual([]); expect(publications).toEqual([]);
  });
  it("propagates lost conditional write without publication; eager revocation is not rollback", async () => {
    const f = fixture({ noResult: true }); f.release(); await expect(invoke(f)).rejects.toThrow("resolved concurrently");
    expect(f.events).toContain("tool-expiry"); expect(publications).toEqual([]);
  });
  it("propagates card storage error without publication", async () => {
    const error = new Error("write-denied"); const f = fixture({ writeError: error }); f.release();
    await expect(invoke(f)).rejects.toBe(error); expect(publications).toEqual([]);
  });
  it("retains ordinary terminal default per-row transaction and touch", async () => {
    const f = fixture(); const rows = await service.issueThreadInteractionService(f.root).expirePendingInteractionsForTerminalIssue(
      { id: "issue-1", companyId: "company-1", status: "done" }, { userId: "user-1" },
    );
    expect(rows[0].status).toBe("expired");
    expect(f.events).toEqual(["pending-read", "legacy-tx", "tool-expiry", "card-expiry", "touch"]);
    expect(f.queries[2].params).toEqual(["interaction-1", "pending"]);
    expect(publications).toEqual(["interaction-1"]);
  });
  it("retains ordinary concurrent-resolution skip without touch", async () => {
    const f = fixture({ noResult: true }); await expect(service.issueThreadInteractionService(f.root).expirePendingInteractionsForTerminalIssue(
      { id: "issue-1", companyId: "company-1", status: "done" },
    )).resolves.toEqual([]);
    expect(f.events).not.toContain("touch"); expect(publications).toEqual([]);
  });
  it("retains ordinary nonterminal no-op", async () => {
    const f = fixture(); await expect(service.issueThreadInteractionService(f.root).expirePendingInteractionsForTerminalIssue(
      { id: "issue-1", companyId: "company-1", status: "blocked" },
    )).resolves.toEqual([]); expect(f.events).toEqual([]);
  });
});
