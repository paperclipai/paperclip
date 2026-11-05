import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { issueContextUsage } from "../services/issue-context-usage.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("issue context usage", () => {
  let db: ReturnType<typeof createDb>;
  let temporaryDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporaryDb = await startEmbeddedPostgresTestDatabase("issue-context-usage-");
    db = createDb(temporaryDb.connectionString);
  }, 60_000);
  afterAll(async () => { await temporaryDb?.cleanup(); });

  function prp(runId: string, sessionId: string, eventType: string, payload: Record<string, unknown>) {
    return { prpEvent: { schema: "paperclip.prp.event.v1", runId, normalizedSessionId: sessionId, eventType, payload } };
  }

  it("returns the latest reported context window and counts the session's compactions", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Context fixture", issuePrefix: `X${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Context", status: "in_progress", assigneeAgentId: agentId },
      { id: otherIssueId, companyId, title: "Other", status: "in_progress", assigneeAgentId: agentId },
    ]);
    expect(await issueContextUsage(db, companyId, issueId)).toBeNull();

    const runId = randomUUID(), otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId, scopeKind: "issue", issueId, status: "running" },
      { id: otherRunId, companyId, agentId, scopeKind: "issue", issueId: otherIssueId, status: "running" },
    ]);
    const usage = (usedTokens: number, total = { inputTokens: 76_682, cacheReadTokens: 48_896, outputTokens: 1_089 }) => ({
      kind: "usage",
      usage: { total, runDelta: total, context: { usedTokens, windowTokens: 258_400 } },
    });
    const base = { companyId, agentId, stream: "system" as const, level: "info" as const };
    await db.insert(heartbeatRunEvents).values([
      { ...base, runId, seq: 1, eventType: "item.completed", payload: prp(runId, "session-a", "item.completed", usage(229_500)),
        createdAt: new Date("2026-11-05T10:00:00Z") },
      { ...base, runId, seq: 2, eventType: "context.compacted", payload: prp(runId, "session-a", "context.compacted", {
        schema: "paperclip.context.compacted.v1", compactionId: "c-1" }), createdAt: new Date("2026-11-05T10:00:01Z") },
      { ...base, runId, seq: 3, eventType: "item.completed", payload: prp(runId, "session-a", "item.completed", usage(38_200)),
        createdAt: new Date("2026-11-05T10:00:02Z") },
      { ...base, runId, seq: 4, eventType: "item.completed", payload: prp(runId, "session-a", "item.completed", { kind: "usage", usage: { total: {} } }),
        createdAt: new Date("2026-11-05T10:00:03Z") },
      { ...base, runId: otherRunId, seq: 1, eventType: "item.completed", payload: prp(otherRunId, "session-b", "item.completed", usage(5)),
        createdAt: new Date("2026-11-05T10:00:04Z") },
    ]);

    expect(await issueContextUsage(db, companyId, issueId)).toMatchObject({
      runId,
      agentId,
      sessionId: "session-a",
      usedTokens: 38_200,
      windowTokens: 258_400,
      totals: { inputTokens: 76_682, cachedInputTokens: 48_896, outputTokens: 1_089 },
      costUsd: null,
      compactions: 1,
    });
    expect(await issueContextUsage(db, randomUUID(), issueId)).toBeNull();
  });
});
