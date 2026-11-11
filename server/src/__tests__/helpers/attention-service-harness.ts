import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
export const describeAttentionEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

export function createAttentionServiceHarness() {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-service-");
    db = createDb(externalUrl ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 30_000);

  afterEach(async () => {
    await db.transaction(async (tx) => {
      // CASCADE emits a notice for every related table; keep cleanup quiet while
      // retaining warnings/errors and the same complete database reset.
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql`TRUNCATE TABLE companies CASCADE`);
    });
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "ATN") {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    const errorAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId,
        companyId,
        name: "Worker",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Broken Agent",
        role: "engineer",
        status: "error",
        errorReason: "adapter config missing",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, workerId, reviewerId, errorAgentId, prefix };
  }

  async function insertIssue(input: {
    companyId: string;
    id?: string;
    identifier: string;
    title: string;
    status: string;
    priority?: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    originKind?: string;
    originId?: string | null;
    originFingerprint?: string;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
    executionState?: Record<string, unknown> | null;
    updatedAt?: Date;
    createdAt?: Date;
    unblockDescriptor?: { owner: { userId: string } | { agentId: string } | "board"; action: string } | null;
    blockedTransitionAt?: Date | null;
    blockedOwnerNotifiedAt?: Date | null;
    visibility?: "open" | "private";
    privacyRootIssueId?: string | null;
    responsibleUserId?: string | null;
    harnessKind?: string | null;
    reviewPolicy?: "anyone" | "not_creator" | "human_only" | null;
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: input.priority ?? "medium",
      reviewPolicy: input.reviewPolicy ?? null,
      parentId: input.parentId ?? null,
      projectId: input.projectId ?? null,
      projectWorkspaceId: input.projectWorkspaceId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originFingerprint: input.originFingerprint ?? "default",
      executionState: input.executionState ?? null,
      unblockDescriptor: input.unblockDescriptor ?? null,
      blockedTransitionAt: input.blockedTransitionAt ?? null,
      blockedOwnerNotifiedAt: input.blockedOwnerNotifiedAt ?? null,
      visibility: input.visibility ?? "open",
      privacyRootIssueId: input.privacyRootIssueId ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
      harnessKind: input.harnessKind ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return id;
  }

  function pendingUserExecutionState(userId = "board-user") {
    return {
      status: "pending",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: "review",
      currentParticipant: { type: "user", userId },
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
    };
  }

  function pendingAgentExecutionState(agentId: string) {
    return {
      ...pendingUserExecutionState(),
      currentParticipant: { type: "agent", agentId },
    };
  }

  return {
    get db() {
      return db;
    },
    seedCompany,
    insertIssue,
    pendingUserExecutionState,
    pendingAgentExecutionState,
  };
}
