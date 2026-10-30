import nativePlanWrites from "./fixtures/native-plan-write-events.json";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, issueWorkProducts } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { activityService } from "../services/activity.js";
import { documentService } from "../services/documents.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task cold-open reads", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("task-cold-open-");
    db = createDb(fixture.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Cold open", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Original instruction", description: "Read this first", identifier: `T${companyId.slice(0, 6)}-1`, issueNumber: 1 });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "native", status: "succeeded" });
  }, 30_000);
  afterAll(async () => { await fixture?.cleanup(); });
  function app(allowedCompany = companyId) {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", source: allowedCompany === companyId ? "local_implicit" : "cloud_tenant", companyIds: [allowedCompany], isInstanceAdmin: allowedCompany === companyId };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }
  it("returns the instruction and saved card projection without related detail and keeps company checks", async () => {
    const response = await request(app()).get(`/api/issues/${issueId}?view=core`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: issueId, description: "Read this first" });
    expect(response.body).not.toHaveProperty("ancestors");
    expect(response.body).toMatchObject({ documentSummaries: [], planDocument: null, workProducts: [] });
    const denied = await request(app(randomUUID())).get(`/api/issues/${issueId}?view=core`);
    expect([403, 404]).toContain(denied.status);
  });
  it("includes saved plan content, document metadata and work products in the core read", async () => {
    const documents = documentService(db);
    await documents.upsertIssueDocument({ issueId, key: "plan", title: "Saved plan", format: "markdown", body: "# Stable plan" });
    await documents.upsertIssueDocument({ issueId, key: "evidence", title: "Saved evidence", format: "markdown", body: "Long saved evidence".repeat(1000) });
    const savedProduct = {
      id: randomUUID(), companyId, issueId, type: "pull_request", provider: "github",
      title: "Saved investigation fix", status: "merged",
      url: "https://github.com/example/reproduction/pull/42",
      metadata: { repository: "example/reproduction", number: 42, additions: 78, deletions: 2 },
    };
    await db.insert(issueWorkProducts).values(savedProduct);
    const response = await request(app()).get(`/api/issues/${issueId}?view=core`);
    expect(response.status).toBe(200);
    expect(response.body.planDocument).toMatchObject({ key: "plan", body: "# Stable plan" });
    expect(response.body.workProducts).toEqual([expect.objectContaining(savedProduct)]);
    expect(response.body.documentSummaries).toEqual(expect.arrayContaining([expect.objectContaining({ key: "evidence", title: "Saved evidence" })]));
    expect(response.body.documentSummaries.every((document: Record<string, unknown>) => !("body" in document))).toBe(true);
    expect(response.body).not.toHaveProperty("ancestors");
  });
  it("returns a bounded recent exchange plus the latest human instruction", async () => {
    const humanId = randomUUID();
    await db.insert(issueComments).values([
      { id: humanId, companyId, issueId, body: "Human direction", authorType: "user", authorUserId: "local-board", createdAt: new Date(0) },
      ...Array.from({ length: 20 }, (_, i) => ({ companyId, issueId, authorType: "agent" as const, authorAgentId: agentId, body: `Reply ${i}`, createdAt: new Date(1000 + i) })),
    ]);
    const response = await request(app()).get(`/api/issues/${issueId}/recent-comments`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.hasMore).toBe(true);
    expect(response.body.comments.map((c: { body: string }) => c.body)).toEqual(["Human direction", "Reply 19", "Reply 18", "Reply 17", "Reply 16"]);
    expect(response.body.latestCommentId).toBe(response.body.comments[1].id);
    expect([403, 404]).toContain((await request(app(randomUUID())).get(`/api/issues/${issueId}/recent-comments`)).status);
  });
  it.each(["user", null] as const)("preserves initial and latest human instructions without a description (authorType=%s)", async (authorType) => {
    const bareIssueId = randomUUID();
    await db.insert(issues).values({ id: bareIssueId, companyId, title: "No description" });
    await db.insert(issueComments).values([
      { companyId, issueId: bareIssueId, body: "Human direction", authorType, authorUserId: "local-board", createdAt: new Date(0) },
      { companyId, issueId: bareIssueId, body: "Newest direction", authorType, authorUserId: "local-board", createdAt: new Date(50_000) },
      ...Array.from({ length: 6 }, (_, i) => ({ companyId, issueId: bareIssueId, body: `New reply ${i}`, authorType: "agent" as const, authorAgentId: agentId, createdAt: new Date(60_000 + i) })),
    ]);
    const response = await request(app()).get(`/api/issues/${bareIssueId}/recent-comments`);
    expect(response.status).toBe(200);
    expect(response.body.comments.map((c: { body: string }) => c.body)).toEqual([
      "Human direction", "Newest direction", "New reply 5", "New reply 4", "New reply 3", "New reply 2",
    ]);
  });
  it("loads the original input receipts outside the recent activity window and ignores replay receipts", async () => {
    const commentId = randomUUID();
    const receiptIssueId = randomUUID();
    await db.insert(issues).values({ id: receiptIssueId, companyId, title: "Steering receipts" });
    await db.insert(activityLog).values([
      { companyId, actorId: "test", entityType: "issue", entityId: receiptIssueId, action: "issue.queued_comment_steered", createdAt: new Date(1), details: { commentId, targetRunId: runId } },
      { companyId, actorId: "test", entityType: "issue", entityId: receiptIssueId, action: "issue.queued_comment_steered", createdAt: new Date(2), details: { commentId, targetRunId: runId, duplicate: true } },
      ...Array.from({ length: 51 }, () => ({ companyId, actorId: "test", entityType: "issue", entityId: receiptIssueId, action: "issue.updated" })),
    ]);
    const activity = activityService(db);
    expect((await activity.forIssue(receiptIssueId, 50)).some(row => row.action === "issue.queued_comment_steered")).toBe(false);
    const facts = await activity.inputFactsForIssue(companyId, receiptIssueId, [commentId]);
    expect(facts).toHaveLength(1);
    expect(facts[0].createdAt).toEqual(new Date(1));
    expect(await activity.inputFactsForIssue(companyId, receiptIssueId, [randomUUID()])).toEqual([]);
    expect(await activity.inputFactsForIssue(randomUUID(), receiptIssueId, [commentId])).toEqual([]);
    expect(await activity.inputFactsForIssue(companyId, randomUUID(), [commentId])).toEqual([]);
  });

  it("pages conversation events without ordinary tools, including identity-less deltas and requests", async () => {
    const event = (seq: number, eventType: string, payload: Record<string, unknown>, itemId?: string) => ({
      companyId, runId, agentId, seq, eventType, payload: { prpEvent: { schema: "paperclip.prp.event.v1", eventType, itemId, payload } },
    });
    await db.insert(heartbeatRunEvents).values([
      event(1, "item.started", { kind: "toolCall", arguments: "large tool arguments" }, "tool"),
      event(2, "item.completed", { kind: "toolCall", output: "x".repeat(100_000) }, "tool"),
      event(3, "item.started", { kind: "agentMessage" }, "message"),
      event(4, "item.delta", { text: "Current progress" }, "message"),
      event(5, "runtime_request.opened", { requestId: "request", prompt: "Which option?" }),
      event(6, "runtime_request.resolved", { requestId: "request" }),
      event(7, "item.completed", { kind: "assistant_message", text: "Final answer" }),
      event(8, "turn.completed", {}),
    ]);
    const service = createHeartbeatRunState(db);
    const first = await service.listEvents(runId, 0, 2, true);
    expect(first.map(e => e.seq)).toEqual([3, 4]);
    const rest = await service.listEvents(runId, 4, 1000, true);
    expect(rest.map(e => e.seq)).toEqual([5, 6, 7, 8]);
    expect(JSON.stringify([...first, ...rest])).not.toContain("large tool arguments");
    expect(await service.listEvents(runId)).toHaveLength(8);
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "succeeded", createdAt: new Date(Date.now() + 1000) });
    const activity = activityService(db);
    await db.insert(activityLog).values(Array.from({ length: 55 }, () => ({
      companyId, actorId: "test", action: "issue.updated", entityType: "issue", entityId: issueId,
    })));
    expect(await activity.forIssue(issueId, 50)).toHaveLength(50);
    expect(await activity.forIssue(issueId)).toHaveLength(55);
    expect(await activity.runsForIssue(companyId, issueId, null, 1)).toHaveLength(1);
    expect(await activity.runsForIssue(companyId, issueId)).toHaveLength(2);
  });
  it("retains only successful Plan writes, with bodies removed in the database", async () => {
    const planRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: planRunId, companyId, agentId, issueId, runtimeMode: "native", status: "succeeded" });
    const event = (seq: number, eventType: string, item: Record<string, unknown>, turnId = "turn-1", sourceKind = "runner") => ({
      companyId, runId: planRunId, agentId, seq, eventType, message: "private tool message",
      payload: { extra: "private outer payload", prpEvent: { schema: "paperclip.prp.event.v1", runId: planRunId,
        sourceKind, turnId, eventType, sourceSeq: seq, itemId: item.id, payload: { kind: item.type, item } } },
    });
    const call = (id: string, key = "plan") => ({ id, type: "tool_use", name: "write_document", input: { key, body: "private plan input" } });
    const result = (id: string, key = "plan") => ({ id, tool_use_id: id, type: "tool_result",
      result: { disposition: "applied", document: { key, body: "private plan output".repeat(10_000) } }, arbitrary: "private extension" });
    await db.insert(heartbeatRunEvents).values([
      event(1, "item.started", call("write-plan")),
      event(2, "item.completed", result("write-plan")),
      event(3, "item.completed", { type: "assistant_message", text: "Plan saved.\u0000" }),
      event(4, "item.started", call("write-plan-revised")),
      event(5, "item.completed", result("write-plan-revised")),
      event(6, "item.started", call("write-notes", "notes")),
      event(7, "item.completed", result("write-notes", "notes")),
      event(8, "item.completed", { ...result("write-plan"), isError: true }),
      event(9, "item.completed", { ...result("write-plan"), result: { disposition: "failed", document: { key: "plan" } } }),
      event(10, "item.completed", result("write-plan"), "turn-1", "control_plane"),
      event(11, "item.completed", result("write-plan"), "unrelated-turn"),
      event(12, "item.completed", result("")),
      event(13, "item.started", call("x".repeat(513))),
      event(14, "item.completed", result("x".repeat(513))),
      event(15, "item.started", { ...call("read-plan"), name: "read_document" }),
      event(16, "item.completed", result("read-plan")),
      { ...event(17, "item.completed", result("write-plan")), payload: { prpEvent: {
        schema: "unknown", sourceKind: "runner", turnId: "turn-1", payload: { item: result("write-plan") } } } },
      event(18, "item.started", { id: "shared", type: "assistant_message", text: "ordinary conversation" }),
      event(19, "item.completed", result("shared", "notes")),
    ]);
    const service = createHeartbeatRunState(db);
    const first = await service.listEvents(planRunId, 0, 1, true);
    expect(first.map(event => event.seq)).toEqual([2]);
    expect(first[0]).toMatchObject({ message: null, payload: { prpEvent: { sourceKind: "runner", sourceSeq: 2,
      payload: { item: { type: "tool_result", id: "write-plan", name: "write_document", input: { key: "plan" },
        result: { disposition: "applied", document: { key: "plan" } } } } } } });
    const rest = await service.listEvents(planRunId, 2, 1000, true);
    expect(rest.map(event => event.seq)).toEqual([3, 5, 18, 19]);
    expect(rest[3]).toMatchObject({ message: "private tool message", payload: { prpEvent: { payload: { item: { result: { document: { key: "notes" } } } } } } });
    expect(rest[0].payload).toMatchObject({ prpEvent: { payload: { item: { text: "Plan saved.\u0000" } } } });
    const writes = [first[0], rest[1]];
    expect(JSON.stringify(writes)).not.toContain("private");
    expect(Buffer.byteLength(JSON.stringify(writes))).toBeLessThan(4_000);
    const full = await service.listEvents(planRunId);
    expect(full).toHaveLength(19);
    expect(full[1].payload).toMatchObject({ extra: "private outer payload", prpEvent: { payload: { item: result("write-plan") } } });
  });

  it.each(nativePlanWrites.captures)("keeps the retained $provider Plan receipt alongside provider activity", async ({ events }) => {
    const captureRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: captureRunId, companyId, agentId, issueId, runtimeMode: "native", status: "succeeded" });
    await db.insert(heartbeatRunEvents).values(events.map(event => ({ ...event, companyId, agentId, runId: captureRunId,
      payload: { prpEvent: { ...event.payload.prpEvent, runId: captureRunId } } })));
    const service = createHeartbeatRunState(db);
    const compact = await service.listEvents(captureRunId, 0, 1000, true);
    expect(compact.map(event => event.seq)).toEqual([events.find(event => event.eventType === "item.completed")!.seq]);
    expect(compact[0].payload).toMatchObject({ prpEvent: { payload: { item: {
      type: "tool_result", name: "write_document", result: { document: { key: "plan" } },
    } } } });
    expect(JSON.stringify(compact)).not.toContain("private fixture body");
    expect(await service.listEvents(captureRunId)).toHaveLength(events.length);
  });

});
