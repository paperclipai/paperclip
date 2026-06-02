import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { boundHeartbeatRunEventPayloadForStorage, heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns runs even when the linked db schema lacks processGroupId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(heartbeatRuns, "processGroupId");
    Object.defineProperty(heartbeatRuns, "processGroupId", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const runs = await heartbeatService(db).list(companyId, agentId, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      expect(runs[0]?.processGroupId ?? null).toBeNull();
      expect(runs[0]).toMatchObject({
        livenessState: "advanced",
        livenessReason: "run produced action evidence",
        continuationAttempt: 1,
        nextAction: "continue implementation",
      });
      expect(runs[0]?.lastUsefulActionAt).toEqual(new Date("2026-04-18T12:00:00Z"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(heartbeatRuns, "processGroupId", originalDescriptor);
      } else {
        delete (heartbeatRuns as Record<string, unknown>).processGroupId;
      }
    }
  });

  it("returns small result json payloads unchanged from getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "done",
        structured: { ok: true },
      },
    });

    const run = await heartbeatService(db).getRun(runId);

    expect(run?.resultJson).toEqual({
      summary: "done",
      structured: { ok: true },
    });
  });

  it("bounds oversized legacy result json payloads on getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    const oversizedNestedPayload = Array.from({ length: 6_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}:${randomUUID()}`,
    ).join("|");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
      truncated: true,
      truncationReason: "oversized_result_json",
      stdoutTruncated: true,
    });
    expect(typeof result?.stdout).toBe("string");
    expect((result?.stdout as string).length).toBeLessThan(oversizedStdout.length);
    expect(result).not.toHaveProperty("nestedHuge");
  });

  async function seedCompany(db: ReturnType<typeof createDb>, companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedAgent(db: ReturnType<typeof createDb>, companyId: string, agentId: string) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  it("offset paging returns the next page in createdAt-desc with id tiebreak and no overlap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedCompany(db, companyId);
    await seedAgent(db, companyId, agentId);

    // Seed 30 runs. Pin several to the SAME createdAt timestamp so the id
    // tiebreaker is exercised (offset paging over a non-unique sort key would
    // otherwise duplicate/skip rows).
    const baseTime = new Date("2026-05-01T00:00:00Z").getTime();
    const seeded: Array<{ id: string; createdAt: Date }> = [];
    for (let i = 0; i < 30; i++) {
      const id = randomUUID();
      // Buckets of 3 share a timestamp.
      const createdAt = new Date(baseTime + Math.floor(i / 3) * 60_000);
      seeded.push({ id, createdAt });
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt,
      });
    }

    const svc = heartbeatService(db);
    const page1 = await svc.list(companyId, agentId, 25, 0);
    const page2 = await svc.list(companyId, agentId, 25, 25);

    expect(page1).toHaveLength(25);
    expect(page2).toHaveLength(5);

    const page1Ids = page1.map((r) => r.id);
    const page2Ids = page2.map((r) => r.id);

    // No overlap between pages.
    expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);

    // Combined pages cover all 30 distinct runs.
    const combined = new Set([...page1Ids, ...page2Ids]);
    expect(combined.size).toBe(30);

    // Stable ordering: createdAt desc, then id desc.
    const expectedOrder = [...seeded]
      .sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        if (t !== 0) return t;
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      })
      .map((r) => r.id);
    expect([...page1Ids, ...page2Ids]).toEqual(expectedOrder);
  });

  it("stats groups by UTC day and status, coerces counts, excludes >14d old rows, and scopes by agent", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await seedCompany(db, companyId);
    await seedAgent(db, companyId, agentId);
    await seedAgent(db, companyId, otherAgentId);

    const now = Date.now();
    const recent = (daysAgo: number) => new Date(now - daysAgo * 24 * 60 * 60 * 1000);

    // Two dates x two statuses for agentId, within the 14-day window.
    await db.insert(heartbeatRuns).values([
      { id: randomUUID(), companyId, agentId, invocationSource: "assignment", status: "succeeded", createdAt: recent(1) },
      { id: randomUUID(), companyId, agentId, invocationSource: "assignment", status: "succeeded", createdAt: recent(1) },
      { id: randomUUID(), companyId, agentId, invocationSource: "assignment", status: "failed", createdAt: recent(1) },
      { id: randomUUID(), companyId, agentId, invocationSource: "assignment", status: "succeeded", createdAt: recent(3) },
      // Older than 14 days -> excluded.
      { id: randomUUID(), companyId, agentId, invocationSource: "assignment", status: "failed", createdAt: recent(20) },
      // Different agent -> excluded by agent scoping.
      { id: randomUUID(), companyId, agentId: otherAgentId, invocationSource: "assignment", status: "succeeded", createdAt: recent(1) },
    ]);

    const svc = heartbeatService(db);
    const stats = await svc.stats(companyId, agentId);

    // Counts are numeric (coerced from bigint count(*)).
    for (const row of stats) {
      expect(typeof row.count).toBe("number");
    }

    const total = stats.reduce((acc, r) => acc + r.count, 0);
    // 3 (day recent(1)) + 1 (day recent(3)) = 4; old row + other agent excluded.
    expect(total).toBe(4);

    // Day strings are UTC YYYY-MM-DD.
    for (const row of stats) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    const succeededRecent = stats.find(
      (r) => r.status === "succeeded" && r.date === recent(1).toISOString().slice(0, 10),
    );
    expect(succeededRecent?.count).toBe(2);
    const failedRecent = stats.find(
      (r) => r.status === "failed" && r.date === recent(1).toISOString().slice(0, 10),
    );
    expect(failedRecent?.count).toBe(1);
  });

  it("latestFailed returns only agents whose newest run failed, in the bounded list shape", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agent1 = randomUUID();
    const agent2 = randomUUID();
    const otherAgent = randomUUID();
    await seedCompany(db, companyId);
    await seedCompany(db, otherCompanyId);
    await seedAgent(db, companyId, agent1);
    await seedAgent(db, companyId, agent2);
    await seedAgent(db, otherCompanyId, otherAgent);

    const t = (s: string) => new Date(s);

    // agent1: older=failed, newest=succeeded -> NOT returned.
    await db.insert(heartbeatRuns).values([
      { id: randomUUID(), companyId, agentId: agent1, invocationSource: "assignment", status: "failed", createdAt: t("2026-05-01T00:00:00Z") },
      { id: randomUUID(), companyId, agentId: agent1, invocationSource: "assignment", status: "succeeded", createdAt: t("2026-05-02T00:00:00Z") },
    ]);

    // agent2: newest=timed_out -> returned. Give it an oversized result_json to
    // assert the bounded summarization path is applied.
    const agent2RunId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    await db.insert(heartbeatRuns).values([
      { id: randomUUID(), companyId, agentId: agent2, invocationSource: "assignment", status: "running", createdAt: t("2026-05-01T00:00:00Z") },
      {
        id: agent2RunId,
        companyId,
        agentId: agent2,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: t("2026-05-03T00:00:00Z"),
        resultJson: { summary: "boom", stdout: oversizedStdout },
        stdoutExcerpt: "should-not-leak",
        stderrExcerpt: "should-not-leak",
      },
    ]);

    // Cross-company failure -> excluded.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      agentId: otherAgent,
      invocationSource: "assignment",
      status: "failed",
      createdAt: t("2026-05-03T00:00:00Z"),
    });

    const svc = heartbeatService(db);
    const failed = await svc.latestFailed(companyId);

    expect(failed).toHaveLength(1);
    const only = failed[0]!;
    expect(only.id).toBe(agent2RunId);
    expect(only.agentId).toBe(agent2);
    expect(only.status).toBe("timed_out");

    // Bounded shape: list() projects stdout/stderrExcerpt as NULL.
    expect(only.stdoutExcerpt ?? null).toBeNull();
    expect(only.stderrExcerpt ?? null).toBeNull();

    // resultJson is the summarized/bounded form, not the raw oversized payload.
    const result = only.resultJson as Record<string, unknown> | null;
    expect(result).not.toBeNull();
    expect(typeof result?.summary).toBe("string");
    if (typeof result?.stdout === "string") {
      expect((result.stdout as string).length).toBeLessThan(oversizedStdout.length);
    }
  });

});

describe("heartbeat run event payload bounding", () => {
  it("truncates oversized adapter metadata before storage", () => {
    const payload = boundHeartbeatRunEventPayloadForStorage({
      adapterType: "codex_local",
      prompt: "x".repeat(40_000),
      context: {
        issueId: "issue-1",
        memory: "y".repeat(40_000),
      },
    });

    expect(payload.adapterType).toBe("codex_local");
    expect(typeof payload.prompt).toBe("string");
    expect((payload.prompt as string).length).toBeLessThan(20_000);
    expect(payload.prompt).toContain("[truncated");
    expect(payload.context).toMatchObject({
      issueId: "issue-1",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(45_000);
  });
});
