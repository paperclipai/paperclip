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

  it.each([false, true])("preserves run ownership in list rows (summary=%s)", async (summary) => {
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
      responsibleUserId: "run-owner",
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

    const runs = await heartbeatService(db).list(companyId, undefined, 5, { summary });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      responsibleUserId: "run-owner",
      error: "Failed after doing useful work",
      ...(summary ? {
        usageJson: null,
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: null,
        logRef: null,
        logSha256: null,
        externalRunId: null,
        processPid: null,
      } : {}),
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
    // Multibyte diagnostics can exceed the result byte budget while remaining
    // within the adapter's character bounds. Other result fields can do so too.
    const terminalSessionFailure = {
      category: "service",
      title: "HTTP 529: overloaded_error",
      details: `request_id=req_retained\n${"診断".repeat(12_000)}`,
      truncatedFields: ["title"],
    };

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
      error: terminalSessionFailure.details,
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
        terminalSessionFailure: {
          ...terminalSessionFailure,
          privateMetadata: oversizedNestedPayload,
        },
        instructionSave: {
          state: "unavailable", contract: "agent_files", entryFile: "AGENTS.md",
          errorCode: "AGENT_FILES_LIMIT_EXCEEDED",
          storageWarning: "Agent storage is full. Runs can continue.".repeat(50),
          privateSyncMetadata: oversizedNestedPayload,
        },
        workspaceRestoreFailure: "restore_unsafe_archive",
        cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
          reason: "Provider cancelled execution ".repeat(50), recordedAt: "2026-10-02T15:00:00.000Z",
          privateMetadata: oversizedNestedPayload },
        acpToolInventoryComplete: true,
        acpPendingToolCount: 0,
        errorFamily: "configuration",
        finalResponseRecorded: true,
        executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
      truncated: true,
      truncationReason: "oversized_result_json",
      stdoutTruncated: true,
      terminalSessionFailure: {
        ...terminalSessionFailure,
        details: expect.stringContaining("request_id=req_retained"),
        retrievalTruncated: true,
      },
      instructionSave: {
        state: "unavailable", contract: "agent_files", entryFile: "AGENTS.md",
        errorCode: "AGENT_FILES_LIMIT_EXCEEDED",
        storageWarning: "Agent storage is full. Runs can continue.".repeat(50).slice(0, 1024),
      },
      workspaceRestoreFailure: "restore_unsafe_archive",
      cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
        reason: "Provider cancelled execution ".repeat(50).slice(0, 512), recordedAt: "2026-10-02T15:00:00.000Z" },
      acpToolInventoryComplete: true,
      acpPendingToolCount: 0,
      errorFamily: "configuration",
      finalResponseRecorded: true,
      executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
    });
    expect(typeof result?.stdout).toBe("string");
    expect((result?.stdout as string).length).toBeLessThan(oversizedStdout.length);
    expect(result).not.toHaveProperty("nestedHuge");
    expect(result?.instructionSave).not.toHaveProperty("privateSyncMetadata");
    expect(result?.cancellation).not.toHaveProperty("privateMetadata");
    expect(result?.terminalSessionFailure).not.toHaveProperty("privateMetadata");
    const diagnostic = result?.terminalSessionFailure as { details: string };
    expect(diagnostic.details).toContain("[truncated for run retrieval; full text in run error/transcript]");
    expect(Buffer.byteLength(diagnostic.details)).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    expect(run?.error).toBe(terminalSessionFailure.details);
  });

  async function seedCompanyWithAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRuns(
    companyId: string,
    agentId: string,
    createdAts: Date[],
  ) {
    const ids = createdAts.map(() => randomUUID());
    await db.insert(heartbeatRuns).values(
      createdAts.map((createdAt, index) => ({
        id: ids[index] as string,
        companyId,
        agentId,
        invocationSource: "assignment" as const,
        status: "completed" as const,
        createdAt,
      })),
    );
    return ids;
  }

  it("pages with offset instead of repeating the first page", async () => {
    // Before offset support every page of a sweep came back byte-identical, so
    // a pager accumulated duplicates and reported a fabricated total.
    const { companyId, agentId } = await seedCompanyWithAgent();
    const ids = await seedRuns(companyId, agentId, [
      new Date("2026-04-18T12:00:05Z"),
      new Date("2026-04-18T12:00:04Z"),
      new Date("2026-04-18T12:00:03Z"),
      new Date("2026-04-18T12:00:02Z"),
      new Date("2026-04-18T12:00:01Z"),
    ]);

    const svc = heartbeatService(db);
    const page1 = await svc.list(companyId, undefined, 2, { offset: 0 });
    const page2 = await svc.list(companyId, undefined, 2, { offset: 2 });
    const page3 = await svc.list(companyId, undefined, 2, { offset: 4 });

    expect(page1.map((run) => run.id)).toEqual([ids[0], ids[1]]);
    expect(page2.map((run) => run.id)).toEqual([ids[2], ids[3]]);
    expect(page3.map((run) => run.id)).toEqual([ids[4]]);
    // The control for "offset is inert": pages must not be identical.
    expect(page2.map((run) => run.id)).not.toEqual(page1.map((run) => run.id));
    const swept = [...page1, ...page2, ...page3].map((run) => run.id);
    expect(new Set(swept).size).toBe(ids.length);
  });

  it("returns each tied run exactly once across a paged sweep", async () => {
    // createdAt alone is not a total order, which is why `list` also orders by
    // id. ⚠️ This test does NOT pin that tiebreaker: measured by removing it,
    // Postgres still returns a consistent order at this size and the test
    // stayed green. It pins the end-to-end property a caller depends on — a
    // paged sweep over tied rows neither duplicates nor drops a row.
    const { companyId, agentId } = await seedCompanyWithAgent();
    const sharedCreatedAt = new Date("2026-04-18T12:00:00Z");
    const ids = await seedRuns(companyId, agentId, [
      sharedCreatedAt,
      sharedCreatedAt,
      sharedCreatedAt,
      sharedCreatedAt,
    ]);

    const svc = heartbeatService(db);
    const swept: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 2) {
      const page = await svc.list(companyId, undefined, 2, { offset });
      swept.push(...page.map((run) => run.id));
    }

    expect(swept).toHaveLength(ids.length);
    expect(new Set(swept)).toEqual(new Set(ids));
  });

  it("counts every run for the company, and per agent", async () => {
    const { companyId, agentId } = await seedCompanyWithAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other runner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await seedRuns(companyId, agentId, [
      new Date("2026-04-18T12:00:03Z"),
      new Date("2026-04-18T12:00:02Z"),
      new Date("2026-04-18T12:00:01Z"),
    ]);
    await seedRuns(companyId, otherAgentId, [
      new Date("2026-04-18T12:00:04Z"),
    ]);

    const svc = heartbeatService(db);
    expect(await svc.countRuns(companyId)).toBe(4);
    expect(await svc.countRuns(companyId, agentId)).toBe(3);
    expect(await svc.countRuns(companyId, otherAgentId)).toBe(1);
    // The count must exceed what a capped page can show, or it proves nothing
    // about truncation.
    const capped = await svc.list(companyId, undefined, 2);
    expect(capped).toHaveLength(2);
    expect(await svc.countRuns(companyId)).toBeGreaterThan(capped.length);
  });

  it("counts zero for a company with no runs", async () => {
    const { companyId } = await seedCompanyWithAgent();
    expect(await heartbeatService(db).countRuns(companyId)).toBe(0);
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
