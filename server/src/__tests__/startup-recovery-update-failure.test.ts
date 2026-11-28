import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn()),
}));
vi.mock("@ai-sdk/anthropic", () => ({}));
vi.mock("@ai-sdk/google", () => ({}));
vi.mock("@ai-sdk/xai", () => ({}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => vi.fn()),
}));

import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("startup recovery continues on update failure", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-startup-recovery-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedSourceWithHealthyChild(input: {
    companyId: string;
    agentId: string;
    label: string;
  }) {
    const sourceId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values([
      { id: sourceId, companyId: input.companyId, title: `Source ${input.label}`, status: "todo" },
      { id: childId, companyId: input.companyId, title: `Child ${input.label}`, status: "todo", parentId: sourceId },
    ]);
    await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      scopeKind: "issue",
      status: "queued",
      contextSnapshot: { issueId: childId },
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: input.companyId,
      sourceIssueId: sourceId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `fingerprint-${input.label}`,
      evidence: { systemRecovery: {} },
      nextAction: "enqueue",
      wakePolicy: { type: "bounded_recovery_owner" },
      attemptCount: 0,
      maxAttempts: 5,
    }).returning();
    return { sourceId, childId, actionId: action.id };
  }

  it("skips a source that would form a blocking cycle, schedules a retry, and resolves the next one", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Startup Recovery Test", issuePrefix: "SRC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test Agent", status: "idle" });

    const cyclic = await seedSourceWithHealthyChild({ companyId, agentId, label: "cyclic" });
    const regular = await seedSourceWithHealthyChild({ companyId, agentId, label: "regular" });
    await db.insert(issueRelations).values({
      companyId,
      issueId: cyclic.sourceId,
      relatedIssueId: cyclic.childId,
      type: "blocks",
    });

    const result = await recoveryService(db, {
      enqueueWakeup: vi.fn().mockResolvedValue(true),
    }).reconcileActiveRecoveryActions({ companyId });

    expect(result.skipped).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.issueIds).toEqual([regular.sourceId]);
    expect(result.blockerStallRetryAt).toBeGreaterThan(Date.now());

    const [cyclicSource] = await db.select().from(issues).where(eq(issues.id, cyclic.sourceId));
    const [regularSource] = await db.select().from(issues).where(eq(issues.id, regular.sourceId));
    expect(cyclicSource.status).toBe("todo");
    expect(regularSource.status).toBe("blocked");

    const [cyclicAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, cyclic.actionId));
    const [regularAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, regular.actionId));
    expect(cyclicAction.status).toBe("active");
    expect(regularAction.status).toBe("resolved");
  });

  it("returns an empty result when no recovery action is active", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Empty Recovery Test", issuePrefix: "SRE" });

    const result = await recoveryService(db, {
      enqueueWakeup: vi.fn().mockResolvedValue(true),
    }).reconcileActiveRecoveryActions({ companyId });

    expect(result).toMatchObject({ resolved: 0, skipped: 0, requeued: 0, issueIds: [], blockerStallRetryAt: null });
  });
});
