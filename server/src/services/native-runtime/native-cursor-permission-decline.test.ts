import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { hasCompletedCursorPermissionDecline, readCompletedCursorPermissionDecline } from "./native-cursor-permission-decline.js";

const binding = { companyId: "company", runId: "run", agentId: "agent" };
function row(seq: number, eventType: string, payload: unknown): any {
  const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn",
    normalizedSessionId: "session", sourceInstanceId: "runner", sourceEventId: `runner:${seq}`, sourceSeq: seq, eventType, payload };
  return { ...binding, seq, eventType, protocolSchemaVersion: 1, sourceInstanceId: "runner", sourceEventId: event.sourceEventId, sourceSeq: seq, payload: { prpEvent: event } };
}
function facts() {
  const created = row(1, "runtime_request.created", { request: { requestId: "request", type: "permission", status: "pending", turnId: "turn",
    origin: { adapter: "acpx-runtime-sidecar", provider: "cursor", method: "session/request_permission" } } });
  const resolved = row(2, "runtime_request.resolved", { requestId: "request", action: "decline", turnId: "turn", requestKind: "permission_approval" });
  const completed = row(3, "turn.completed", { status: "completed", error: null });
  return { rows: [created, resolved, completed], terminal: structuredClone(completed.payload.prpEvent) as PrpEvent };
}
describe("completed Cursor permission decline", () => {
  it("fences a committed denial without treating it as semantic success or requiring provider billing", () => {
    const f = facts(); expect(hasCompletedCursorPermissionDecline(f.rows, binding, f.terminal)).toBe(true);
  });
  it.each(["company", "agent", "run", "turn", "session", "source", "provider", "method", "accept", "expired", "duplicate", "order", "terminal"])("rejects %s mismatches and ambiguous proof", mutation => {
    const f = facts(), created = f.rows[0], resolved = f.rows[1];
    if (mutation === "company") created.companyId = "foreign";
    if (mutation === "agent") created.agentId = "foreign";
    if (mutation === "run") created.runId = "foreign";
    if (mutation === "turn") created.payload.prpEvent.turnId = "foreign";
    if (mutation === "session") created.payload.prpEvent.normalizedSessionId = "foreign";
    if (mutation === "source") resolved.sourceSeq = 99;
    if (mutation === "provider") created.payload.prpEvent.payload.request.origin.provider = "claude";
    if (mutation === "method") created.payload.prpEvent.payload.request.origin.method = "cursor/create_plan";
    if (mutation === "accept") resolved.payload.prpEvent.payload.action = "accept";
    if (mutation === "expired") { resolved.eventType = "runtime_request.expired"; resolved.payload.prpEvent.eventType = resolved.eventType; }
    if (mutation === "duplicate") f.rows.push(structuredClone(resolved));
    if (mutation === "order") resolved.seq = 4;
    if (mutation === "terminal") f.terminal.sourceEventId = "foreign";
    expect(hasCompletedCursorPermissionDecline(f.rows, binding, f.terminal)).toBe(false);
  });
});

function readerDb(rows: unknown[]) {
  const query = {
    from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(), limit: vi.fn(async () => rows),
  };
  return { db: { select: vi.fn(() => query) } as unknown as Db, query };
}

describe("permission decline reader event budget", () => {
  it("scopes the database read to the terminal turn and runner before limiting events", async () => {
    const f = facts(), { db, query } = readerDb(f.rows);
    expect(await readCompletedCursorPermissionDecline(db, binding, f.terminal)).toBe(true);
    const predicate = new PgDialect().sqlToQuery(query.where.mock.calls[0]![0]);
    expect(predicate.sql).toContain("->'prpEvent'->>'turnId'");
    expect(predicate.sql).toContain("->'prpEvent'->>'normalizedSessionId'");
    expect(predicate.sql).toContain('"source_instance_id"');
    expect(predicate.params.slice(0, 6)).toEqual(["company", "run", "agent", "turn", "session", "runner"]);
    expect(query.limit).toHaveBeenCalledWith(1001);
    expect(query.where.mock.invocationCallOrder[0]).toBeLessThan(query.limit.mock.invocationCallOrder[0]!);
  });
  it("fails closed if this same turn exceeds its control-event budget", async () => {
    const f = facts(), { db } = readerDb(Array.from({ length: 1001 }, () => f.rows[0]));
    await expect(readCompletedCursorPermissionDecline(db, binding, f.terminal)).rejects.toThrow("exceeds control-event budget");
  });
});
