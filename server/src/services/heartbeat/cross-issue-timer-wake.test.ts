import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  crossIssueInfluenceRunContextError,
  observeCrossIssueInfluence,
} from "../cross-issue-influence-limit.js";


const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("timer wake cross-issue guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timer-wake-");
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

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const ownIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Timer Agent",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other Agent",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: ownIssueId,
        companyId,
        title: "Own actionable task",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "board-user",
      },
      {
        id: otherIssueId,
        companyId,
        title: "Someone else's task",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: otherAgentId,
        responsibleUserId: "board-user",
      },
    ]);

    return { companyId, agentId, ownIssueId, otherIssueId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: input.contextSnapshot,
    });
    return id;
  }

  it("allows an own-task write when the timer wake carries the source issue", async () => {
    const { companyId, agentId, ownIssueId } = await fixture();
    // This is exactly the snapshot tickTimers() now emits.
    const runId = await insertRun({
      companyId,
      agentId,
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        now: new Date().toISOString(),
        timerClaimWasFirstHeartbeat: false,
        issueId: ownIssueId,
      },
    });

    const decision = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: ownIssueId,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    });

    expect(decision).toBeNull();
  });

  it("refuses a contextless write to another actor's task with an explicit error", async () => {
    const { companyId, agentId, otherIssueId } = await fixture();
    const runId = await insertRun({
      companyId,
      agentId,
      contextSnapshot: { source: "scheduler", reason: "interval_elapsed", now: new Date().toISOString() },
    });

    await expect(
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId: otherIssueId,
        kind: "comment",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("tells the agent the run id was received instead of asking for a header it sent", () => {
    const plain = crossIssueInfluenceRunContextError();
    const withRun = crossIssueInfluenceRunContextError({ runIdPresent: true, runId: "run-123" });

    const runContextError = withRun as { status: number; details: Record<string, unknown> };
    expect(runContextError.status).toBe(403);
    expect(runContextError.details).toBeTruthy();
    // HttpError carries the flattened copy on `message`; `details` holds the code.
    const plainMessage = (plain as { message: string }).message;
    const runMessage = (withRun as { message: string }).message;
    expect(plainMessage).not.toContain("already present");
    expect(runMessage).toContain("already present");
    expect(runMessage).toContain("run-123");
  });
});
