import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  ContextCompactionError,
  contextCompactionService,
  contextCompactionSupport,
  isContextCompactionRun,
  readContextCompactionRequest,
} from "../services/context-compaction.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("context compaction support", () => {
  it("supports Codex and Claude on the Paperclip runner only", () => {
    expect(contextCompactionSupport({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } }).supported).toBe(true);
    expect(contextCompactionSupport({ adapterType: "paperclip_runner", adapterConfig: {} }).supported).toBe(true);
    expect(contextCompactionSupport({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } }).supported).toBe(true);
    expect(contextCompactionSupport({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi" } }).supported).toBe(false);
    expect(contextCompactionSupport({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" } }).supported).toBe(false);
    expect(contextCompactionSupport({ adapterType: "codex_local", adapterConfig: {} }).supported).toBe(false);
  });

  it("recognizes a compaction run from its context", () => {
    expect(readContextCompactionRequest({ contextCompactionRequestId: "req-1" })).toEqual({ requestId: "req-1" });
    expect(isContextCompactionRun({ contextCompactionRequestId: " " })).toBe(false);
    expect(isContextCompactionRun({ goalControlRequestId: "goal-1" })).toBe(false);
    expect(isContextCompactionRun(null)).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("context compaction availability", () => {
  let db: ReturnType<typeof createDb>;
  let temporaryDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporaryDb = await startEmbeddedPostgresTestDatabase("context-compaction-");
    db = createDb(temporaryDb.connectionString);
  }, 60_000);
  afterAll(async () => { await temporaryDb?.cleanup(); });

  async function fixture(adapterConfig: Record<string, unknown> = { provider: "codex" }, adapterType = "paperclip_runner") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Compaction fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "idle", adapterType, adapterConfig });
    await db.insert(issues).values({ id: issueId, companyId, title: "Compact", status: "in_progress", assigneeAgentId: agentId });
    return { companyId, agentId, issue: { id: issueId, assigneeAgentId: agentId as string | null, status: "in_progress" } };
  }

  it("is available for an idle supported agent and queues a compaction run", async () => {
    const { companyId, agentId, issue } = await fixture();
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    const service = contextCompactionService(db, { wakeup });
    expect(await service.availability(companyId, issue)).toEqual({ status: "available", reasonCode: null, reason: null });
    const accepted = await service.request({ companyId, issue, userId: "board-user" });
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "context_compaction",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      allowRunCoalescing: false,
      manualUserWake: true,
      contextSnapshot: expect.objectContaining({
        issueId: issue.id,
        contextCompactionRequestId: accepted.requestId,
        skipIssueComment: true,
      }),
    }));
  });

  it("waits for an active run and reports a compaction already underway", async () => {
    const { companyId, agentId, issue } = await fixture();
    const service = contextCompactionService(db, { wakeup: vi.fn() });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, scopeKind: "issue", issueId: issue.id, status: "running" });
    expect(await service.availability(companyId, issue)).toMatchObject({ status: "unavailable", reasonCode: "agent_busy" });
    await expect(service.request({ companyId, issue, userId: "board-user" })).rejects.toMatchObject({ code: "agent_busy" });

    const { companyId: otherCompanyId, agentId: otherAgentId, issue: otherIssue } = await fixture();
    const compactionRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: compactionRunId, companyId: otherCompanyId, agentId: otherAgentId, scopeKind: "issue", status: "queued",
      contextSnapshot: { issueId: otherIssue.id, contextCompactionRequestId: "req-1" },
    });
    expect(await service.availability(otherCompanyId, otherIssue)).toEqual({
      status: "pending", reasonCode: null, reason: null, runId: compactionRunId,
    });
    await expect(service.request({ companyId: otherCompanyId, issue: otherIssue, userId: "board-user" }))
      .rejects.toBeInstanceOf(ContextCompactionError);
  });

  it("explains unsupported harnesses, closed tasks, and missing assignees", async () => {
    const unsupported = await fixture({ provider: "opencode" });
    const service = contextCompactionService(db);
    expect(await service.availability(unsupported.companyId, unsupported.issue)).toMatchObject({
      status: "unavailable", reasonCode: "unsupported",
    });
    const closed = await fixture();
    expect(await service.availability(closed.companyId, { ...closed.issue, status: "done" })).toMatchObject({
      status: "unavailable", reasonCode: "task_closed",
    });
    expect(await service.availability(closed.companyId, { ...closed.issue, assigneeAgentId: null })).toMatchObject({
      status: "unavailable", reasonCode: "no_assignee",
    });
  });
});
