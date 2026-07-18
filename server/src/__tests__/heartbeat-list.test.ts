import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
    await db.delete(issues);
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

  it("returns summary list rows without heavy run detail fields", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 123,
      },
      resultJson: {
        summary: "large run summary",
        stdout: "x".repeat(20_000),
      },
      sessionIdBefore: "session-before",
      sessionIdAfter: "session-after",
      logStore: "local",
      logRef: "logs/run.log",
      logSha256: "abc123",
      externalRunId: "external-run",
      processPid: 12345,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });

    const runs = await heartbeatService(db).list(companyId, undefined, 5, { summary: true });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: null,
      resultJson: null,
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logSha256: null,
      externalRunId: null,
      processPid: null,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
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

  it("lists safe run details for a caller-specified time window", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const missingIssueRunId = randomUUID();
    const outsideRunId = randomUUID();

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
      title: "Founding Engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: { secret: "must-not-leak" },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix the failing run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: "PC-123",
    });

    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "issue_assigned",
        status: "failed",
        startedAt: new Date("2026-07-18T10:00:00.000Z"),
        finishedAt: new Date("2026-07-18T10:05:00.000Z"),
        createdAt: new Date("2026-07-18T09:59:00.000Z"),
        error: "Raw stack with token sk-secret and patient data must not leak",
        stdoutExcerpt: "transcript must not leak",
        stderrExcerpt: "stderr must not leak",
        resultJson: {
          error: "raw adapter error must not leak",
          stdout: "raw stdout must not leak",
        },
        errorCode: "provider_quota",
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
        },
      },
      {
        id: missingIssueRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        startedAt: new Date("2026-07-18T11:00:00.000Z"),
        finishedAt: new Date("2026-07-18T11:30:00.000Z"),
        errorCode: null,
        contextSnapshot: {
          issueId: randomUUID(),
          taskKey: "external-task-1",
        },
      },
      {
        id: outsideRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        startedAt: new Date("2026-07-17T11:00:00.000Z"),
        errorCode: "adapter_failed",
        contextSnapshot: {
          issueId,
        },
      },
    ]);

    const details = await heartbeatService(db).listRunDetails(companyId, {
      start: new Date("2026-07-18T00:00:00.000Z"),
      end: new Date("2026-07-19T00:00:00.000Z"),
      limit: 10,
    });

    expect(details.map((run) => run.id)).toEqual([missingIssueRunId, failedRunId]);

    expect(details[1]).toMatchObject({
      id: failedRunId,
      agent: {
        id: agentId,
        name: "CodexCoder",
        role: "engineer",
        title: "Founding Engineer",
        status: "running",
        adapterType: "codex_local",
      },
      linkedEntityId: issueId,
      linkedIssue: {
        id: issueId,
        identifier: "PC-123",
        title: "Fix the failing run",
        status: "in_progress",
      },
      status: "failed",
      durationMs: 300_000,
      wakeReason: "issue_assigned",
      failure: {
        failureClass: "provider_quota",
        safeReasonSummary: "Run failed with safe error code provider_quota.",
      },
    });

    expect(details[0]).toMatchObject({
      id: missingIssueRunId,
      linkedIssue: null,
      status: "timed_out",
      durationMs: 1_800_000,
      failure: {
        failureClass: "timeout",
        safeReasonSummary: "Run timed out.",
      },
    });

    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain("Raw stack");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("stderr must not leak");
    expect(serialized).not.toContain("raw adapter error");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("sk-secret");
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
