import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentConfigRevisions,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentService } from "../services/agents.ts";
import {
  normalizeHeartbeatAutoPauseErrorClass,
  resolveHeartbeatErrorAutoPausePolicy,
} from "../services/heartbeat-error-autopause.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `이 호스트에서 embedded Postgres heartbeat error auto-pause 테스트를 건너뜁니다: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("heartbeat error auto-pause 정규화", () => {
  it("명확한 provider/runtime 오류만 auto-pause 대상으로 분류한다", () => {
    expect(normalizeHeartbeatAutoPauseErrorClass({
      id: randomUUID(),
      status: "failed",
      errorCode: "claude_auth_required",
      error: "Please run claude login",
      resultJson: null,
    })).toBe("auth_failed");

    expect(normalizeHeartbeatAutoPauseErrorClass({
      id: randomUUID(),
      status: "failed",
      errorCode: "adapter_failed",
      error: "Unit tests failed: expected 200 but got 500",
      resultJson: { stopReason: "adapter_failed" },
    })).toBeNull();

    expect(normalizeHeartbeatAutoPauseErrorClass({
      id: randomUUID(),
      status: "failed",
      errorCode: "max_turns_exhausted",
      error: "Maximum turns reached",
      resultJson: { stopReason: "max_turns_exhausted" },
    })).toBeNull();
  });

  it("feature flag false 값은 guard를 비활성화한다", () => {
    expect(resolveHeartbeatErrorAutoPausePolicy({ HEARTBEAT_ERROR_AUTOPAUSE_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveHeartbeatErrorAutoPausePolicy({ HEARTBEAT_ERROR_AUTOPAUSE_ENABLED: "1" }).enabled).toBe(true);
  });
});

describeEmbeddedPostgres("heartbeat error auto-pause guard", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let agentsSvc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-error-autopause-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    agentsSvc = agentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input?: {
    runtimeConfig?: Record<string, unknown>;
    adapterType?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: input?.adapterType ?? "claude_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          enabled: true,
          intervalSec: 900,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    at: string;
    status?: "succeeded" | "failed";
    error?: string | null;
    errorCode?: string | null;
    resultJson?: Record<string, unknown> | null;
    issueId?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
  }) {
    const runId = randomUUID();
    const at = new Date(input.at);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: input.status ?? "failed",
      error: input.error ?? null,
      errorCode: input.errorCode ?? null,
      resultJson: input.resultJson ?? null,
      contextSnapshot: input.contextSnapshot ?? (input.issueId ? { issueId: input.issueId } : null),
      startedAt: new Date(at.getTime() - 1_000),
      finishedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    return runId;
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    identifier?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Synthetic auto-pause issue",
      status: "in_progress",
      assigneeAgentId: input.agentId,
      issueNumber: Math.floor(Math.random() * 100_000),
      identifier: input.identifier ?? `T-${issueId.slice(0, 8)}`,
    });
    return issueId;
  }

  async function readRuntimeConfig(agentId: string) {
    const [row] = await db
      .select({ runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.runtimeConfig as Record<string, unknown>;
  }

  async function readIssueComments(issueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(issueComments.createdAt, issueComments.id);
  }

  it("2회 실패는 미발화하고 3회 동일 class에서 pause를 기록한다", async () => {
    const { companyId, agentId } = await seedAgent();
    const commonError = "You've hit your usage limit for GPT-5. Try again at 11:31 PM.";
    await seedRun({ companyId, agentId, at: "2026-05-14T00:00:00.000Z", errorCode: "codex_transient_upstream", error: commonError });
    const secondRunId = await seedRun({ companyId, agentId, at: "2026-05-14T00:01:00.000Z", errorCode: "codex_transient_upstream", error: commonError });

    const secondResult = await heartbeat.applyHeartbeatErrorAutoPause(secondRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(secondResult).toMatchObject({ outcome: "below_threshold", count: 2, code: "monthly_usage_limit" });
    expect(((await readRuntimeConfig(agentId)).heartbeat as Record<string, unknown>).enabled).toBe(true);

    const thirdRunId = await seedRun({ companyId, agentId, at: "2026-05-14T00:02:00.000Z", errorCode: "codex_transient_upstream", error: commonError });
    const thirdResult = await heartbeat.applyHeartbeatErrorAutoPause(thirdRunId, {
      policy: { enabled: true, threshold: 3 },
    });

    expect(thirdResult).toMatchObject({
      outcome: "paused",
      code: "monthly_usage_limit",
      count: 3,
      lastRunId: thirdRunId,
    });
    const runtimeConfig = await readRuntimeConfig(agentId);
    expect((runtimeConfig.heartbeat as Record<string, unknown>).enabled).toBe(false);
    expect(runtimeConfig.pauseReason).toMatchObject({
      code: "monthly_usage_limit",
      adapter: "claude_local",
      consecutiveErrorCount: 3,
      lastRunId: thirdRunId,
      guardVersion: "heartbeat-error-autopause/v1",
      sourceIssueId: "ARI-103",
      previousHeartbeatEnabled: true,
    });

    const duplicateResult = await heartbeat.applyHeartbeatErrorAutoPause(thirdRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(duplicateResult).toMatchObject({ outcome: "already_paused", code: "monthly_usage_limit" });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, thirdRunId));
    expect(events.filter((event) => event.message?.includes("heartbeat auto-pause guard"))).toHaveLength(1);
  });

  it("성공 run이 중간에 있으면 연속 실패 카운터를 리셋한다", async () => {
    const { companyId, agentId } = await seedAgent();
    const error = "You're out of extra usage. Resets at 4pm.";
    await seedRun({ companyId, agentId, at: "2026-05-14T01:00:00.000Z", errorCode: "claude_transient_upstream", error });
    await seedRun({ companyId, agentId, at: "2026-05-14T01:01:00.000Z", status: "succeeded", error: null, errorCode: null });
    await seedRun({ companyId, agentId, at: "2026-05-14T01:02:00.000Z", errorCode: "claude_transient_upstream", error });
    const currentRunId = await seedRun({ companyId, agentId, at: "2026-05-14T01:03:00.000Z", errorCode: "claude_transient_upstream", error });

    const result = await heartbeat.applyHeartbeatErrorAutoPause(currentRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(result).toMatchObject({ outcome: "below_threshold", count: 2 });
    expect(((await readRuntimeConfig(agentId)).heartbeat as Record<string, unknown>).enabled).toBe(true);
  });

  it("서로 다른 error class가 섞이면 pause하지 않는다", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedRun({ companyId, agentId, at: "2026-05-14T02:00:00.000Z", error: "rate limit exceeded: 429" });
    await seedRun({ companyId, agentId, at: "2026-05-14T02:01:00.000Z", error: "quota exceeded for current account" });
    const currentRunId = await seedRun({ companyId, agentId, at: "2026-05-14T02:02:00.000Z", error: "rate limit exceeded: 429" });

    const result = await heartbeat.applyHeartbeatErrorAutoPause(currentRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(result).toMatchObject({ outcome: "below_threshold", count: 1, code: "rate_limit_exceeded" });
    expect(((await readRuntimeConfig(agentId)).heartbeat as Record<string, unknown>).enabled).toBe(true);
  });

  it("업무 실패는 auto-pause 대상에서 제외한다", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedRun({ companyId, agentId, at: "2026-05-14T03:00:00.000Z", error: "Unit tests failed: expected 200 but got 500" });
    await seedRun({ companyId, agentId, at: "2026-05-14T03:01:00.000Z", error: "Unit tests failed: expected 200 but got 500" });
    const currentRunId = await seedRun({ companyId, agentId, at: "2026-05-14T03:02:00.000Z", error: "Unit tests failed: expected 200 but got 500" });

    const result = await heartbeat.applyHeartbeatErrorAutoPause(currentRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(result).toMatchObject({ outcome: "not_target" });
    expect(((await readRuntimeConfig(agentId)).heartbeat as Record<string, unknown>).enabled).toBe(true);
  });

  it("adapter 설정 변경과 명시적 재개 revision은 카운터를 리셋한다", async () => {
    const { companyId, agentId } = await seedAgent();
    const error = "You've hit your usage limit for GPT-5. Try again at 11:31 PM.";
    await seedRun({ companyId, agentId, at: "2026-05-14T04:00:00.000Z", errorCode: "codex_transient_upstream", error });
    await seedRun({ companyId, agentId, at: "2026-05-14T04:01:00.000Z", errorCode: "codex_transient_upstream", error });
    await db.insert(agentConfigRevisions).values({
      companyId,
      agentId,
      source: "patch",
      changedKeys: ["adapterConfig"],
      beforeConfig: { adapterConfig: { model: "old" } },
      afterConfig: { adapterConfig: { model: "new" } },
      createdAt: new Date("2026-05-14T04:01:30.000Z"),
    });
    const currentRunId = await seedRun({ companyId, agentId, at: "2026-05-14T04:02:00.000Z", errorCode: "codex_transient_upstream", error });

    const result = await heartbeat.applyHeartbeatErrorAutoPause(currentRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(result).toMatchObject({ outcome: "below_threshold", count: 1 });
    expect(((await readRuntimeConfig(agentId)).heartbeat as Record<string, unknown>).enabled).toBe(true);

    const resumed = await seedAgent();
    await seedRun({ companyId: resumed.companyId, agentId: resumed.agentId, at: "2026-05-14T05:00:00.000Z", errorCode: "codex_transient_upstream", error });
    await seedRun({ companyId: resumed.companyId, agentId: resumed.agentId, at: "2026-05-14T05:01:00.000Z", errorCode: "codex_transient_upstream", error });
    await db.insert(agentConfigRevisions).values({
      companyId: resumed.companyId,
      agentId: resumed.agentId,
      source: "heartbeat_auto_resume",
      changedKeys: ["runtimeConfig"],
      beforeConfig: { runtimeConfig: { heartbeat: { enabled: false } } },
      afterConfig: { runtimeConfig: { heartbeat: { enabled: true } } },
      createdAt: new Date("2026-05-14T05:01:30.000Z"),
    });
    const resumedRunId = await seedRun({ companyId: resumed.companyId, agentId: resumed.agentId, at: "2026-05-14T05:02:00.000Z", errorCode: "codex_transient_upstream", error });

    const resumedResult = await heartbeat.applyHeartbeatErrorAutoPause(resumedRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(resumedResult).toMatchObject({ outcome: "below_threshold", count: 1 });
    expect(((await readRuntimeConfig(resumed.agentId)).heartbeat as Record<string, unknown>).enabled).toBe(true);
  });

  it("수동 재개 후 24시간 내 동일 fingerprint는 N=1로 재발화하고 alert comment를 디바운스한다", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const error = "You've hit your usage limit for GPT-5. Try again at 11:31 PM.";
    await seedRun({ companyId, agentId, issueId, at: "2026-05-14T06:00:00.000Z", errorCode: "codex_transient_upstream", error });
    await seedRun({ companyId, agentId, issueId, at: "2026-05-14T06:01:00.000Z", errorCode: "codex_transient_upstream", error });
    const firstPauseRunId = await seedRun({ companyId, agentId, issueId, at: "2026-05-14T06:02:00.000Z", errorCode: "codex_transient_upstream", error });

    const firstPauseResult = await heartbeat.applyHeartbeatErrorAutoPause(firstPauseRunId, {
      policy: { enabled: true, threshold: 3 },
    });
    expect(firstPauseResult).toMatchObject({
      outcome: "paused",
      count: 3,
      threshold: 3,
    });
    const firstPauseConfig = await readRuntimeConfig(agentId);
    const firstPauseReason = firstPauseConfig.pauseReason as Record<string, unknown>;
    const fingerprint = firstPauseReason.fingerprint;
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    const firstComments = await readIssueComments(issueId);
    expect(firstComments).toHaveLength(1);
    expect(firstComments[0]?.body).toContain("heartbeat-auto-pause-alert:v1");
    expect(firstComments[0]?.body).toContain(String(fingerprint));

    await agentsSvc.recordHeartbeatAutoResume(agentId, {
      resumeReason: "provider_limit_resolved",
      resumedBy: {
        type: "agent",
        id: agentId,
      },
      resumedAt: "2026-05-14T06:10:00.000Z",
    });
    await db
      .update(agentConfigRevisions)
      .set({ createdAt: new Date("2026-05-14T06:10:00.000Z") })
      .where(eq(agentConfigRevisions.source, "heartbeat_auto_resume"));

    const refireRunId = await seedRun({ companyId, agentId, issueId, at: "2026-05-14T06:11:00.000Z", errorCode: "codex_transient_upstream", error });
    const refireResult = await heartbeat.applyHeartbeatErrorAutoPause(refireRunId, {
      policy: { enabled: true, threshold: 3 },
    });

    expect(refireResult).toMatchObject({
      outcome: "paused",
      count: 1,
      threshold: 1,
      code: "monthly_usage_limit",
    });
    const refireConfig = await readRuntimeConfig(agentId);
    expect(refireConfig.pauseReason).toMatchObject({
      consecutiveErrorCount: 1,
      lastRunId: refireRunId,
      fingerprint,
    });

    const commentsAfterRefire = await readIssueComments(issueId);
    expect(commentsAfterRefire).toHaveLength(1);

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, refireRunId));
    expect(events.some((event) => (event.payload as Record<string, unknown> | null)?.quickRefire === true)).toBe(true);
  });
});
