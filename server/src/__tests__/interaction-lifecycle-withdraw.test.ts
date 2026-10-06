import { describe, expect, it, vi } from "vitest";
import { issues, issueThreadInteractions, toolActionRequests } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import * as service from "../services/issue-thread-interactions.js";
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
vi.mock("../services/chat-interaction-publications.js", () => ({ enqueueTerminalIssueInteractionChatPublications: async () => {} }));
function fixture(config: { status?: string; missingIssue?: boolean; missingCard?: boolean; cardStatus?: string; activeTool?: boolean; noResult?: boolean; writeError?: Error } = {}) {
  const events: string[] = []; const queries: any[] = []; const patches: any[] = []; const dialect = new PgDialect();
  let release!: () => void; let reject!: (e: Error) => void;
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const row = { id: "interaction-1", companyId: "company-1", issueId: "issue-1", kind: "request_confirmation", status: config.cardStatus ?? "pending", payload: { version: 1, prompt: "Offline fixture" }, result: null };
  const tx: any = {
    transaction: () => { throw new Error("nested-transaction"); },
    execute: async (q: any) => { events.push("fence"); expect(dialect.sqlToQuery(q).params).toEqual(["paperclip:issue-lifecycle:company-1"]); await barrier; },
    select: () => ({ from: (table: any) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q));
      if (table === issues) return { for: async (mode: string) => { expect(mode).toBe("update"); events.push("issue-lock"); return config.missingIssue ? [] : [{ id: "issue-1", companyId: "company-1", status: config.status ?? "blocked" }]; } };
      if (table === issueThreadInteractions) { events.push("card-read"); return Promise.resolve(config.missingCard ? [] : [row]); }
      expect(table).toBe(toolActionRequests); events.push("active-tool-read"); return Promise.resolve(config.activeTool ? [{ id: "tool-1" }] : []);
    } }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: (q: any) => {
      queries.push(dialect.sqlToQuery(q)); patches.push(patch);
      if (table === toolActionRequests) { events.push("tool-write"); return Promise.resolve(); }
      expect(table).toBe(issueThreadInteractions); events.push("card-write"); return { returning: async () => { if (config.writeError) throw config.writeError; return config.noResult ? [] : [{ ...row, ...patch }]; } };
    } }) }),
  };
  return { tx, events, queries, patches, row, release, reject };
}
const invoke = (f: ReturnType<typeof fixture>, issue = { id: "issue-1", companyId: "company-1" }, actor = { userId: "user-1" }, input = { reason: "Offline withdrawal" }, queue: any = []) =>
  (service as any).withdrawInteractionInTransaction(f.tx, issue, "interaction-1", input, actor, { postCommitPublications: queue });
describe("dark supplied root-first canonical withdrawal recording", () => {
  it("fences before authoritative issue lock, card read and canonical withdrawal", async () => {
    const f = fixture(); const pending = Promise.resolve().then(() => invoke(f)); void pending.catch(() => {});
    try { await Promise.resolve(); expect(f.events).toEqual(["fence"]); expect(f.queries).toEqual([]); }
    finally { f.release(); }
    const result = await pending;
    expect(result).toMatchObject({ id: "interaction-1", status: "cancelled", resolvedByUserId: "user-1" });
    expect(f.events).toEqual(["fence", "issue-lock", "card-read", "tool-write", "active-tool-read", "card-write"]);
    expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
    expect(f.queries[1].params).toEqual(["interaction-1", "company-1", "issue-1"]);
    expect(f.queries.at(-1).params).toEqual(["interaction-1", "pending", "company-1", "issue-1"]);
  });
  it("captures routing reason and actor before fence suspension", async () => {
    const f = fixture(); const issue = { id: "issue-1", companyId: "company-1" }; const actor = { userId: "user-1" }; const input = { reason: " Original " };
    const pending = invoke(f, issue, actor, input); Object.assign(issue, { id: "other", companyId: "foreign" }); actor.userId = "other"; input.reason = "Changed";
    f.release(); const row = await pending;
    expect(row).toMatchObject({ resolvedByUserId: "user-1", result: { reason: "Original" } });
    expect(f.queries[0].params).toEqual(["issue-1", "company-1"]);
  });
  for (const status of ["done", "cancelled"]) it(`vetoes authoritative closed ${status} before card reads`, async () => {
    const f = fixture({ status }); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 409 });
    expect(f.events).toEqual(["fence", "issue-lock"]); expect(f.patches).toEqual([]);
  });
  for (const config of [{ missingIssue: true }, { missingCard: true }]) it(`vetoes missing endpoint ${JSON.stringify(config)}`, async () => {
    const f = fixture(config); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 404 }); expect(f.patches).toEqual([]);
  });
  it("vetoes a foreign returned card without writes", async () => {
    const f = fixture(); f.row.companyId = "foreign"; f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 404 }); expect(f.patches).toEqual([]);
  });
  it("retains pending-only guard", async () => {
    const f = fixture({ cardStatus: "cancelled" }); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 409 }); expect(f.patches).toEqual([]);
  });
  it("vetoes active linked tool after eager revocation recording; not rollback", async () => {
    const f = fixture({ activeTool: true }); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 409 }); expect(f.events).not.toContain("card-write");
    expect(f.events).toContain("tool-write");
  });
  it("propagates lost conditional-write result", async () => {
    const f = fixture({ noResult: true }); f.release(); await expect(invoke(f)).rejects.toMatchObject({ status: 409 }); expect(f.events).toContain("tool-write");
  });
  it("propagates storage failure identity", async () => {
    const error = new Error("storage-denied"); const f = fixture({ writeError: error }); f.release(); await expect(invoke(f)).rejects.toBe(error);
  });
  it("propagates fence rejection without reads or writes", async () => {
    const f = fixture(); const error = new Error("fence-denied"); const assertion = expect(invoke(f)).rejects.toBe(error); f.reject(error); await assertion; expect(f.queries).toEqual([]);
  });
  for (const queue of [null, {}, "queue"]) it(`denies malformed queue ${JSON.stringify(queue)} before effects`, async () => {
    const f = fixture(); await expect(invoke(f, undefined, undefined, undefined, queue)).rejects.toMatchObject({ status: 422 }); expect(f.events).toEqual([]);
  });
  it("denies missing company before effects", async () => {
    const f = fixture(); await expect(invoke(f, { id: "issue-1", companyId: "" })).rejects.toMatchObject({ status: 422 }); expect(f.events).toEqual([]);
  });
  it("preserves ordinary ID-only read/write and owned transaction/hook/touch", async () => {
    const f = fixture(); const root = { ...f.tx, transaction: async (cb: any) => { f.events.push("tx"); return cb(f.tx); },
      update: (table: any) => table === issues ? { set: () => ({ where: async () => { f.events.push("touch"); } }) } : f.tx.update(table) };
    const row = await service.issueThreadInteractionService(root as any).withdrawInteraction(
      { id: "issue-1", companyId: "company-1" }, "interaction-1", {}, { userId: "user-1" }, { afterResolveInTransaction: async (tx) => { expect(tx).toBe(f.tx); f.events.push("hook"); } },
    );
    expect(row.status).toBe("cancelled"); expect(f.events).toEqual(["card-read", "tx", "tool-write", "active-tool-read", "card-write", "hook", "touch"]);
    expect(f.queries[0].params).toEqual(["interaction-1"]); expect(f.queries.at(-1).params).toEqual(["interaction-1", "pending"]);
  });
});
