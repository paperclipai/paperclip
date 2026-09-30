import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeContext = support.supported || externalTestDatabaseUrl ? describe : describe.skip;

describeContext("heartbeat transcript context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let cleanupCompanyId: string | null = null;
  let cleanupAgentId: string | null = null;
  let cleanupRunId: string | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-transcript-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (cleanupRunId) {
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, cleanupRunId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, cleanupRunId));
    }
    if (cleanupAgentId) await db.delete(agents).where(eq(agents.id, cleanupAgentId));
    if (cleanupCompanyId) await db.delete(companies).where(eq(companies.id, cleanupCompanyId));
    cleanupRunId = null;
    cleanupAgentId = null;
    cleanupCompanyId = null;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
  });

  it("keeps pending requests and final records outside the bounded tail window", async () => {
    const companyId = cleanupCompanyId = randomUUID();
    const agentId = cleanupAgentId = randomUUID();
    const runId = cleanupRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Context fixture", issuePrefix: "CTX" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Context agent" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });

    const protocolEvent = (seq: number, eventType: string, payload: Record<string, unknown>) => ({
      companyId,
      agentId,
      runId,
      seq,
      eventType,
      stream: "system",
      level: "info",
      payload: {
        prpEvent: {
          schema: "paperclip.prp.event.v1",
          schemaVersion: 1,
          eventType,
          sourceKind: "runner",
          runId,
          turnId: "turn-context",
          sourceEventId: `event-${seq}`,
          emittedAt: new Date("2026-09-28T12:00:00.000Z").toISOString(),
          payload,
        },
      },
    });
    const pending = protocolEvent(1, "runtime_request.created", {
      request: { requestId: "pending-before-tail", requestKind: "user_input", turnId: "turn-context", status: "pending" },
    });
    const resolved = protocolEvent(3, "runtime_request.resolved", {
      request: { requestId: "resolved-before-tail", requestKind: "user_input", turnId: "turn-context", status: "resolved" },
    });
    const oldResolvedCreation = protocolEvent(2, "runtime_request.created", {
      request: { requestId: "resolved-before-tail", requestKind: "user_input", turnId: "turn-context", status: "pending" },
    });
    const finalMessage = protocolEvent(4, "item.completed", {
      kind: "agentMessage",
      channel: "final",
      item: { id: "final-1", kind: "agentMessage", channel: "final", text: "The answer before a long control tail." },
    });
    const unknownChannelMessage = protocolEvent(8, "item.completed", {
      kind: "agentMessage",
      channel: "unknown",
      text: "Legacy unknown-channel final message.",
    });
    const acceptedResult = (seq: number) => protocolEvent(seq, "run.result.accepted", {
      result: { schema: "paperclip.run_result.v1", summary: `accepted-${seq}` },
    });
    const terminal = protocolEvent(7, "run.terminal", {
      schema: "paperclip.prp.terminal.v1",
      turnTerminalState: "completed",
      runTerminalState: "succeeded",
      reportedWorkDisposition: "done",
    });
    const tailEvents = Array.from({ length: 34 }, (_, index) => ({
      companyId,
      agentId,
      runId,
      seq: index + 11,
      eventType: "item.started",
      stream: "system",
      level: "info",
      payload: { prpEvent: { eventType: "item.started", runId, payload: { kind: "toolCall" } } },
    }));
    await db.insert(heartbeatRunEvents).values([
      pending,
      oldResolvedCreation,
      resolved,
      finalMessage,
      acceptedResult(5),
      acceptedResult(6),
      terminal,
      ...tailEvents,
    ] as never);

    const service = heartbeatService(db);
    const tail = await service.listEventPage(runId, { afterSeq: "tail", limit: 5 });
    const context = await service.listTranscriptContext(runId, companyId);
    const contextSeqs = context.map((event) => event.seq);

    expect(tail.events.map((event) => event.seq)).toEqual([40, 41, 42, 43, 44]);
    expect(contextSeqs).toContain(1);
    expect(contextSeqs).not.toContain(3);
    expect(contextSeqs).toContain(4);
    expect(contextSeqs).toContain(5);
    expect(contextSeqs).toContain(6);
    expect(contextSeqs).toContain(7);

    await db.insert(heartbeatRunEvents).values([unknownChannelMessage] as never);
    const unknownContext = await service.listTranscriptContext(runId, companyId);
    expect(unknownContext.map((event) => event.seq)).toContain(4);
    expect(unknownContext.map((event) => event.seq)).not.toContain(8);

    await db.delete(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.seq, 4),
    ));
    const fallbackContext = await service.listTranscriptContext(runId, companyId);
    expect(fallbackContext.map((event) => event.seq)).toContain(8);

    const missingChannelMessage = protocolEvent(9, "item.completed", {
      kind: "agentMessage",
      text: "Legacy message without a channel.",
    });
    const analysisMessage = protocolEvent(10, "item.completed", {
      kind: "agentMessage",
      channel: "analysis",
      text: "Analysis must not be promoted to a final response.",
    });
    await db.insert(heartbeatRunEvents).values([missingChannelMessage, analysisMessage] as never);
    const latestContext = await service.listTranscriptContext(runId, companyId);
    const latestContextSeqs = latestContext.map((event) => event.seq);
    expect(latestContextSeqs).toContain(9);
    expect(latestContextSeqs).not.toContain(8);
    expect(latestContextSeqs).not.toContain(10);
  });
});
