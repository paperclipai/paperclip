import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  deliveryEvents,
  environments,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueAttachments,
  issueInboxArchives,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { workProductService } from "../services/work-products.ts";
import {
  clampIssueListLimit,
  deriveIssueCommentRunLogAttribution,
  assertFactoryExecutionPolicySnapshotPreserved,
  assertFactoryIssueAccessBoundaryPreserved,
  authorizeFactoryManagedCreate,
  authorizeFactoryManagedTransition,
  FACTORY_IRREVERSIBLE_ACTION_APPROVAL_TARGET_KEY,
  ISSUE_LIST_MAX_LIMIT,
  MAX_DIRECT_CHILD_ISSUES_PER_PARENT,
  issueService,
  parseWorkItemTypeFilter,
  resolveIssueChildTopologyPolicy,
  validateDelegatedIssueExecutionContract,
} from "../services/issues.ts";
import {
  buildProjectMentionHref,
  MAX_ISSUE_REQUEST_DEPTH,
  type IssueExecutionPolicy,
} from "@paperclipai/shared";
import {
  DEFAULT_FACTORY_POLICY_V1,
  effectiveFactoryExecutionLaneMaximum,
  factoryPolicyStageIsSelected,
  factoryPolicyContentHash,
  factoryStageEvidenceGates,
  factoryStageReturnTarget,
} from "../services/ai-factory-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("issue list limit helpers", () => {
  it("clamps untrusted issue-list limits to the server maximum", () => {
    expect(clampIssueListLimit(0)).toBe(1);
    expect(clampIssueListLimit(25.9)).toBe(25);
    expect(clampIssueListLimit(ISSUE_LIST_MAX_LIMIT + 10)).toBe(ISSUE_LIST_MAX_LIMIT);
  });

  it("parses comma-separated work item filters and ignores unknown values", () => {
    expect(parseWorkItemTypeFilter("initiative,human_task,unknown")).toEqual(["initiative", "human_task"]);
  });
});

describe("resolveIssueChildTopologyPolicy", () => {
  it("gives an explicit execution-contract topology precedence over a policy snapshot", () => {
    expect(resolveIssueChildTopologyPolicy({
      executionContract: {
        extensions: {
          aiFactory: { topologyMode: "same_issue_only" },
        },
      },
      executionPolicy: {
        mode: "normal",
        stages: [],
        factory: {
          schemaVersion: 1,
          laneKind: "control",
          topologyMode: "direct_execution_lanes",
          coordinator: { type: "agent", agentId: randomUUID() },
          policyKey: "paperclip-ai-factory",
          policyVersion: "1",
          policyHash: "deadbeef",
          maxExecutionLanes: 8,
        },
      },
    })).toEqual({
      mode: "same_issue_only",
      maxExecutionLanes: 0,
      source: "execution_contract",
    });
  });

  it("recognizes the legacy create-no-children constraint without scanning unrelated prose", () => {
    expect(resolveIssueChildTopologyPolicy({
      executionContract: {
        core: {
          objective: "Document the child component behavior",
          constraints: ["Complete this on the same issue; create no children."],
        },
      },
      executionPolicy: null,
    })).toEqual({
      mode: "same_issue_only",
      maxExecutionLanes: 0,
      source: "legacy_contract_constraint",
    });

    expect(resolveIssueChildTopologyPolicy({
      executionContract: {
        core: {
          objective: "Document the child component behavior",
          constraints: ["Keep the existing component hierarchy."],
        },
      },
      executionPolicy: null,
    }).mode).toBe("direct_execution_lanes");
  });

  it("uses the snapshotted policy lane cap when no contract override exists", () => {
    expect(resolveIssueChildTopologyPolicy({
      executionContract: null,
      executionPolicy: {
        mode: "normal",
        stages: [],
        factory: {
          schemaVersion: 1,
          laneKind: "control",
          topologyMode: "single_execution_lane",
          coordinator: { type: "agent", agentId: randomUUID() },
          policyKey: "paperclip-ai-factory",
          policyVersion: "1",
          policyHash: "deadbeef",
          maxExecutionLanes: 9,
        },
      },
    })).toMatchObject({
      mode: "single_execution_lane",
      maxExecutionLanes: 1,
      source: "execution_policy",
    });
  });

  it("does not let a looser execution contract override a frozen control lane cap", () => {
    expect(resolveIssueChildTopologyPolicy({
      executionContract: {
        extensions: {
          aiFactory: {
            topologyMode: "direct_execution_lanes",
            maxExecutionLanes: 10,
          },
        },
      },
      executionPolicy: {
        mode: "normal",
        stages: [],
        factory: {
          schemaVersion: 1,
          laneKind: "control",
          topologyMode: "single_execution_lane",
          coordinator: { type: "agent", agentId: randomUUID() },
          policyKey: "paperclip-ai-factory",
          policyVersion: "1",
          policyHash: "deadbeef",
          maxExecutionLanes: 1,
        },
      },
    })).toEqual({
      mode: "single_execution_lane",
      maxExecutionLanes: 1,
      source: "execution_policy",
    });
  });
});

describe("assertFactoryExecutionPolicySnapshotPreserved", () => {
  const factoryPolicy = {
    mode: "normal" as const,
    commentRequired: true,
    stages: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      key: "implementation",
      type: "work" as const,
      role: "engineer",
      approvalsNeeded: 1 as const,
      participants: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        type: "agent" as const,
        agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }],
    }],
    factory: {
      schemaVersion: 1 as const,
      laneKind: "execution" as const,
      topologyMode: "direct_execution_lanes" as const,
      coordinator: { type: "agent" as const, agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      policyKey: "paperclip-ai-factory",
      policyVersion: "1",
      policyHash: "deadbeef",
      maxExecutionLanes: 3,
    },
  };

  it("allows monitor-only edits while rejecting removal or stage replacement", () => {
    expect(() => assertFactoryExecutionPolicySnapshotPreserved({
      previous: factoryPolicy,
      next: {
        ...factoryPolicy,
        monitor: {
          nextCheckAt: "2026-07-17T10:00:00.000Z",
          notes: "Check the external operation.",
          scheduledBy: "assignee",
          maxAttempts: 3,
        },
      },
    })).not.toThrow();
    for (const next of [null, { ...factoryPolicy, stages: [] }]) {
      expect(() => assertFactoryExecutionPolicySnapshotPreserved({
        previous: factoryPolicy,
        next,
      })).toThrowError(expect.objectContaining({
        status: 409,
        details: expect.objectContaining({ code: "factory_policy_frozen" }),
      }));
    }
  });

  it("freezes project and visibility when a factory snapshot already exists", () => {
    const existing = {
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      visibility: "private",
      executionPolicy: factoryPolicy,
    };

    expect(() => assertFactoryIssueAccessBoundaryPreserved({
      existing,
      patch: { projectId: existing.projectId, visibility: existing.visibility },
    })).not.toThrow();
    expect(() => assertFactoryIssueAccessBoundaryPreserved({
      existing,
      patch: {
        projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        visibility: "company",
      },
    })).toThrowError(expect.objectContaining({
      status: 409,
      details: expect.objectContaining({
        code: "factory_access_boundary_frozen",
        fields: ["projectId", "visibility"],
      }),
    }));
  });

  it("freezes the current boundary in the same mutation that first pins a factory snapshot", () => {
    expect(() => assertFactoryIssueAccessBoundaryPreserved({
      existing: {
        projectId: null,
        visibility: "company",
        executionPolicy: null,
      },
      patch: {
        projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        executionPolicy: factoryPolicy,
      },
    })).toThrowError(expect.objectContaining({
      status: 409,
      details: expect.objectContaining({
        code: "factory_access_boundary_frozen",
        fields: ["projectId"],
      }),
    }));
  });
});

describe("validateDelegatedIssueExecutionContract", () => {
  it("accepts a complete core contract while leaving extensions open", () => {
    expect(validateDelegatedIssueExecutionContract({
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "qa",
      core: {
        objective: "Verify the lane against the source issue.",
        why: "The executor must preserve the parent intent during handoff.",
        sourceOfTruth: {
          links: ["https://paper.zenova.id/SIX/issues/SIX-3697"],
        },
        acceptanceChecks: ["The issue preserves its human-readable description."],
        handoffNotes: {
          managerReasoning: "The child lane needs the hidden contract to avoid context loss.",
        },
      },
      extensions: {
        qa: {
          reviewMode: "contract_fidelity",
        },
      },
    })).toEqual({ valid: true, warnings: [] });
  });

  it("warns when an agent-created child issue has no execution contract", () => {
    expect(validateDelegatedIssueExecutionContract(null)).toEqual({
      valid: false,
      warnings: ["executionContract is required for agent-created child issues"],
    });
  });

  it("warns for missing required core handoff fields", () => {
    const result = validateDelegatedIssueExecutionContract({
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "implementation",
      core: {
        objective: "Build the change.",
        sourceOfTruth: {
          files: [],
        },
        acceptanceChecks: [],
        handoffNotes: {},
      },
    });

    expect(result.valid).toBe(false);
    expect(result.warnings).toEqual([
      "executionContract.core.why is required",
      "executionContract.core.sourceOfTruth must contain at least one source",
      "executionContract.core.acceptanceChecks must contain at least one check",
      "executionContract.core.handoffNotes.managerReasoning is required",
    ]);
  });
});

function makeValidExecutionContract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    contractType: "delegated_task",
    taskType: "implementation",
    core: {
      objective: "Build the delegated lane.",
      why: "The executor needs the manager intent without rereading the parent thread.",
      sourceOfTruth: {
        links: ["https://paper.zenova.id/PAP/issues/PAP-100"],
      },
      acceptanceChecks: ["The delegated work satisfies the parent intent."],
      handoffNotes: {
        managerReasoning: "This lane is the concrete executable slice of the parent issue.",
      },
    },
    ...overrides,
  };
}

function descriptionWithInlineExecutionContract(
  prefix: string,
  contract: Record<string, unknown>,
) {
  return [
    prefix,
    "",
    "## Execution Contract",
    "",
    "```json",
    JSON.stringify(contract),
    "```",
  ].join("\n");
}

describe("deriveIssueCommentRunLogAttribution", () => {
  it("recovers agent attribution from run logs that printed the posted comment id", () => {
    const commentId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();

    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "user-1",
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId,
          agentId,
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: `comment id: ${commentId}\n`,
        },
      ],
    );

    expect(derived.get(commentId)).toEqual({
      derivedAuthorAgentId: agentId,
      derivedCreatedByRunId: runId,
      derivedAuthorSource: "run_log_comment_post",
    });
  });

  it("does not rewrite comments without exact run-log proof", () => {
    const commentId = randomUUID();
    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "user-1",
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId: randomUUID(),
          agentId: randomUUID(),
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: "posted results without echoing the comment id",
        },
      ],
    );

    expect(derived.has(commentId)).toBe(false);
  });
});

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueAttachments);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(assets);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("calculates automatic human lifecycle seconds from issue creation to terminal state", async () => {
    const companyId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const humanTaskId = randomUUID();
    const userOwnedAiIssueId = randomUUID();
    const aiOnlyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: humanTaskId,
        companyId,
        title: "Human task",
        status: "done",
        workItemType: "human_task",
        priority: "medium",
        createdAt: new Date("2026-07-01T10:00:00.000Z"),
        completedAt: new Date("2026-07-10T13:00:00.000Z"),
        updatedAt: new Date("2026-07-10T13:00:00.000Z"),
      },
      {
        id: userOwnedAiIssueId,
        companyId,
        title: "User-owned AI issue",
        status: "cancelled",
        workItemType: "ai_task",
        priority: "medium",
        assigneeUserId: "user-1",
        createdAt: new Date("2026-07-01T10:00:00.000Z"),
        cancelledAt: new Date("2026-07-01T11:00:00.000Z"),
        updatedAt: new Date("2026-07-01T11:00:00.000Z"),
      },
      {
        id: aiOnlyIssueId,
        companyId,
        title: "AI only issue",
        status: "done",
        workItemType: "ai_task",
        priority: "medium",
        createdAt: new Date("2026-07-01T10:00:00.000Z"),
        completedAt: new Date("2026-07-01T14:00:00.000Z"),
        updatedAt: new Date("2026-07-01T14:00:00.000Z"),
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "test",
        action: "issue.updated",
        entityType: "issue",
        entityId: humanTaskId,
        details: { status: "done", _previous: { status: "in_review" } },
        createdAt: new Date("2026-07-01T13:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "test",
        action: "issue.updated",
        entityType: "issue",
        entityId: humanTaskId,
        details: { status: "done", _previous: { status: "done" } },
        createdAt: new Date("2026-07-10T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});
    const byId = new Map(result.map((issue) => [issue.id, issue]));

    expect(byId.get(humanTaskId)?.actualHumanSeconds).toBe(10_800);
    expect(byId.get(userOwnedAiIssueId)?.actualHumanSeconds).toBe(3_600);
    expect(byId.get(aiOnlyIssueId)?.actualHumanSeconds).toBe(14_400);
  });

  it("filters issue lists by one or more work item types", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const initiativeId = randomUUID();
    const humanTaskId = randomUUID();
    const aiTaskId = randomUUID();

    await db.insert(issues).values([
      {
        id: initiativeId,
        companyId,
        title: "Planning initiative",
        status: "todo",
        priority: "medium",
        workItemType: "initiative",
      },
      {
        id: humanTaskId,
        companyId,
        title: "Human follow-up",
        status: "todo",
        priority: "medium",
        workItemType: "human_task",
      },
      {
        id: aiTaskId,
        companyId,
        title: "AI execution",
        status: "todo",
        priority: "medium",
        workItemType: "ai_task",
      },
    ]);

    const workHubIds = (await svc.list(companyId, {
      workItemType: "initiative,human_task",
    })).map((issue) => issue.id);
    expect(new Set(workHubIds)).toEqual(new Set([initiativeId, humanTaskId]));

    const humanTaskIds = (await svc.list(companyId, {
      workItemType: "human_task",
    })).map((issue) => issue.id);
    expect(humanTaskIds).toEqual([humanTaskId]);

    await expect(svc.list(companyId, { workItemType: "unknown" })).resolves.toEqual([]);
  });

  it("prevents AI agent assignment for human control work items", async () => {
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
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(svc.create(companyId, {
      title: "Human follow-up",
      status: "todo",
      priority: "medium",
      workItemType: "human_task",
      assigneeAgentId: agentId,
    })).rejects.toMatchObject({ status: 422 });

    await expect(svc.create(companyId, {
      title: "Planning initiative",
      status: "todo",
      priority: "medium",
      workItemType: "initiative",
      assigneeAgentId: agentId,
    })).rejects.toMatchObject({ status: 422 });

    const humanTaskId = randomUUID();
    await db.insert(issues).values({
      id: humanTaskId,
      companyId,
      title: "Existing human task",
      status: "todo",
      priority: "medium",
      workItemType: "human_task",
    });

    await expect(svc.update(humanTaskId, {
      assigneeAgentId: agentId,
    })).rejects.toMatchObject({ status: 422 });

    await expect(svc.checkout(humanTaskId, agentId, ["todo"], null)).rejects.toMatchObject({ status: 422 });
  });

  it("combines participation filtering with search", async () => {
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
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("applies result limits to issue search", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const exactIdentifierId = randomUUID();
    const titleMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(issues).values([
      {
        id: exactIdentifierId,
        companyId,
        issueNumber: 42,
        identifier: "PAP-42",
        title: "Completely unrelated",
        status: "todo",
        priority: "medium",
      },
      {
        id: titleMatchId,
        companyId,
        title: "Search ranking issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Another item",
        description: "Contains the search keyword",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, {
      q: "search",
      limit: 2,
    });

    expect(result.map((issue) => issue.id)).toEqual([titleMatchId, descriptionMatchId]);
  });

  it("ranks comment matches ahead of description-only matches", async () => {
    const companyId = randomUUID();
    const commentMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: commentMatchId,
        companyId,
        title: "Comment match",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Description match",
        description: "Contains pull/3303 in the description",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentMatchId,
      body: "Reference: https://github.com/paperclipai/paperclip/pull/3303",
    });

    const result = await svc.list(companyId, {
      q: "pull/3303",
      limit: 2,
      includeRoutineExecutions: true,
    });

    expect(result.map((issue) => issue.id)).toEqual([commentMatchId, descriptionMatchId]);
  });

  it("filters issue lists to the full descendant tree for a root issue", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const siblingId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: siblingId,
        companyId,
        title: "Sibling",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId });

    expect(new Set(result.map((issue) => issue.id))).toEqual(new Set([childId, grandchildId]));
  });

  it("combines descendant filtering with search", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const outsideMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Relevant parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Needle grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: outsideMatchId,
        companyId,
        title: "Needle outside",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId, q: "needle" });

    expect(result.map((issue) => issue.id)).toEqual([grandchildId]);
  });

  it("accepts issue identifiers with alphanumeric prefixes through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PC1A2",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1064,
      identifier: "PC1A2-1064",
      title: "Feedback votes error",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    const issue = await svc.getById("pc1a2-1064");

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        identifier: "PC1A2-1064",
      }),
    );
  });

  it("returns null instead of throwing for malformed non-uuid issue refs", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });
  it("filters issues by execution workspace id", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const linkedIssueId = randomUUID();
    const otherLinkedIssueId = randomUUID();
    const unlinkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: targetWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Target workspace",
        status: "active",
        providerType: "local_fs",
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values([
      {
        id: linkedIssueId,
        companyId,
        projectId,
        title: "Linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: targetWorkspaceId,
      },
      {
        id: otherLinkedIssueId,
        companyId,
        projectId,
        title: "Other linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: otherWorkspaceId,
      },
      {
        id: unlinkedIssueId,
        companyId,
        projectId,
        title: "Unlinked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { executionWorkspaceId: targetWorkspaceId });

    expect(result.map((issue) => issue.id)).toEqual([linkedIssueId]);
  });

  it("filters issues by generic workspace id across execution and project workspace links", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const executionLinkedIssueId = randomUUID();
    const projectLinkedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Feature workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: false,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values([
      {
        id: executionLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Execution linked issue",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: projectLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Project linked issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId,
        projectId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const executionResult = await svc.list(companyId, { workspaceId: executionWorkspaceId });
    const projectResult = await svc.list(companyId, { workspaceId: projectWorkspaceId });

    expect(executionResult.map((issue) => issue.id)).toEqual([executionLinkedIssueId]);
    expect(projectResult.map((issue) => issue.id).sort()).toEqual([executionLinkedIssueId, projectLinkedIssueId].sort());
  });

  it("hides plugin operation issues from default lists and inbox-style filters while preserving explicit retrieval", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const normalIssueId = randomUUID();
    const pluginVisibleIssueId = randomUUID();
    const operationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Runner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin operations",
      status: "in_progress",
    });
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        title: "Normal issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: pluginVisibleIssueId,
        companyId,
        title: "Plugin-visible issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:feature",
      },
      {
        id: operationIssueId,
        companyId,
        projectId,
        title: "Plugin operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:operation",
        originId: "mission-alpha:operation-1",
      },
    ]);

    const defaultIssueIds = (await svc.list(companyId)).map((issue) => issue.id);
    expect(defaultIssueIds).toContain(normalIssueId);
    expect(defaultIssueIds).toContain(pluginVisibleIssueId);
    expect(defaultIssueIds).not.toContain(operationIssueId);

    const inboxIssueIds = (await svc.list(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
    })).map((issue) => issue.id);
    expect(inboxIssueIds).toContain(normalIssueId);
    expect(inboxIssueIds).not.toContain(operationIssueId);

    await expect(svc.list(companyId, { originKind: "plugin:paperclip.missions:operation" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);
    await expect(svc.list(companyId, { originId: "mission-alpha:operation-1" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);

    const projectIssueIds = (await svc.list(companyId, { projectId })).map((issue) => issue.id);
    expect(projectIssueIds).toContain(operationIssueId);

    const advancedIssueIds = (await svc.list(companyId, { includePluginOperations: true })).map((issue) => issue.id);
    expect(advancedIssueIds).toContain(operationIssueId);
  });

  it("excludes plugin operation issues from unread inbox counts", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const otherUserId = "other-user";
    const normalIssueId = randomUUID();
    const operationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        title: "Normal touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
      },
      {
        id: operationIssueId,
        companyId,
        title: "Plugin operation touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        originKind: "plugin:paperclip.missions:operation",
      },
    ]);
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: normalIssueId,
        authorUserId: otherUserId,
        body: "Unread normal update.",
      },
      {
        companyId,
        issueId: operationIssueId,
        authorUserId: otherUserId,
        body: "Unread operation update.",
      },
    ]);

    await expect(svc.countUnreadTouchedByUser(companyId, userId, "todo")).resolves.toBe(1);
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(companyId, archivedIssueId, userId, new Date("2026-03-26T12:30:00.000Z"));
    await svc.archiveInbox(companyId, resurfacedIssueId, userId, new Date("2026-03-26T13:00:00.000Z"));

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("resurfaces archived issue when status/updatedAt changes after archiving", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with old comment then status change",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T10:00:00.000Z"),
    });

    // Old external comment before archiving
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: otherUserId,
      body: "Old comment before archive",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    // Archive after seeing the comment
    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-03-26T12:00:00.000Z"),
    );

    // Verify it's archived
    const afterArchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    // Status/work update changes updatedAt (no new comment)
    await db
      .update(issues)
      .set({
        status: "in_progress",
        updatedAt: new Date("2026-03-26T13:00:00.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Should resurface because updatedAt > archivedAt
    const afterUpdate = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterUpdate.map((i) => i.id)).toContain(issueId);
  });

  it("sorts and exposes last activity from comments and non-local issue activity logs", async () => {
    const companyId = randomUUID();
    const olderIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const activityIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: commentIssueId,
        companyId,
        title: "Comment activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: activityIssueId,
        companyId,
        title: "Logged activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentIssueId,
      body: "New comment without touching issue.updatedAt",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: activityIssueId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: olderIssueId,
        createdAt: new Date("2026-03-26T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});

    expect(result.map((issue) => issue.id)).toEqual([
      activityIssueId,
      commentIssueId,
      olderIssueId,
    ]);
    expect(result.find((issue) => issue.id === activityIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T12:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === commentIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T11:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === olderIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T10:00:00.000Z",
    );
  });

  it("paginates earlier comments in descending order from an anchor comment", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const anchorCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paged comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "First comment",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: anchorCommentId,
        companyId,
        issueId,
        body: "Anchor comment",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: latestCommentId,
        companyId,
        issueId,
        body: "Latest comment",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: anchorCommentId,
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([firstCommentId]);
  });

  it("includes direct and markdown-referenced attachments on comment rows", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const directAssetId = randomUUID();
    const linkedAssetId = randomUUID();
    const directAttachmentId = randomUUID();
    const linkedAttachmentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Attachment comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      body: `Please inspect [trace.csv](/api/attachments/${linkedAttachmentId}/content), rows 4-9.`,
      createdAt: new Date("2026-03-26T12:00:00.000Z"),
      updatedAt: new Date("2026-03-26T12:00:00.000Z"),
    });

    await db.insert(assets).values([
      {
        id: directAssetId,
        companyId,
        provider: "local",
        objectKey: "issues/direct-screenshot.png",
        contentType: "image/png",
        byteSize: 1234,
        sha256: "direct-sha",
        originalFilename: "direct-screenshot.png",
      },
      {
        id: linkedAssetId,
        companyId,
        provider: "local",
        objectKey: "issues/trace.csv",
        contentType: "text/csv",
        byteSize: 4567,
        sha256: "linked-sha",
        originalFilename: "trace.csv",
      },
    ]);

    await db.insert(issueAttachments).values([
      {
        id: directAttachmentId,
        companyId,
        issueId,
        assetId: directAssetId,
        issueCommentId: commentId,
      },
      {
        id: linkedAttachmentId,
        companyId,
        issueId,
        assetId: linkedAssetId,
        issueCommentId: null,
      },
    ]);

    const comments = await svc.listComments(issueId, { order: "asc" });

    expect(comments).toHaveLength(1);
    expect(comments[0]?.attachments?.map((attachment) => attachment.id)).toEqual([
      directAttachmentId,
      linkedAttachmentId,
    ]);
    expect(comments[0]?.attachments?.[0]).toMatchObject({
      originalFilename: "direct-screenshot.png",
      contentPath: `/api/attachments/${directAttachmentId}/content`,
      issueCommentId: commentId,
    });
    expect(comments[0]?.attachments?.[1]).toMatchObject({
      originalFilename: "trace.csv",
      contentPath: `/api/attachments/${linkedAttachmentId}/content`,
      issueCommentId: null,
    });
  });

  it("includes blockedBy summaries on list rows in one batched pass", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const unblockedId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: unblockedId,
        companyId,
        title: "Unblocked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const defaultResult = await svc.list(companyId);
    expect(defaultResult.find((issue) => issue.id === blockedId)?.blockedBy).toBeUndefined();

    const result = await svc.list(companyId, { includeBlockedBy: true });
    const byId = new Map(result.map((issue) => [issue.id, issue]));

    expect(byId.get(blockedId)?.blockedBy).toEqual([
      expect.objectContaining({
        id: blockerId,
        identifier: null,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      }),
    ]);
    expect(byId.get(blockerId)?.blockedBy).toEqual([]);
    expect(byId.get(unblockedId)?.blockedBy).toEqual([]);
  });

  it("trims list payload fields that can grow large on issue index routes", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const longDescription = "x".repeat(5_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Large issue",
      description: longDescription,
      status: "todo",
      priority: "medium",
      executionPolicy: { stages: Array.from({ length: 20 }, (_, index) => ({ index, kind: "review", notes: "y".repeat(400) })) },
      executionState: { history: Array.from({ length: 20 }, (_, index) => ({ index, body: "z".repeat(400) })) },
      executionWorkspaceSettings: { notes: "w".repeat(2_000) },
    });

    const [result] = await svc.list(companyId);

    expect(result).toBeTruthy();
    expect(result?.description).toHaveLength(1200);
    expect(result?.executionPolicy).toBeNull();
    expect(result?.executionState).toBeNull();
    expect(result?.executionWorkspaceSettings).toBeNull();
  });

  it("does not let description preview truncation split multibyte characters", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const description = `${"x".repeat(1199)}— still valid after truncation`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Multibyte boundary issue",
      description,
      status: "todo",
      priority: "medium",
    });

    const [result] = await svc.list(companyId);

    expect(result?.description).toHaveLength(1200);
    expect(result?.description?.endsWith("—")).toBe(true);
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("captures the assignee default environment when neither issue nor project specifies one", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(issue.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
      environmentId: assigneeEnvironmentId,
    });
  });

  it("does not promote the assignee default environment when the project policy already specifies one", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const projectEnvironmentId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: projectEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
        environmentId: projectEnvironmentId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    // Project policy's environmentId must win over the assignee's default;
    // executionWorkspaceSettings should not bake in an environmentId in this case
    // so resolveExecutionWorkspaceEnvironmentId can fall through to the project
    // policy's value at run time.
    expect(issue.executionWorkspaceSettings).toEqual({ mode: "shared_workspace" });
  });

  it("captures the new assignee's default environment on reassignment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: firstEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: secondEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "QA SSH Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId,
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "QA E2B Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId,
        permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Environment matrix: ssh / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(created.executionWorkspaceSettings).toMatchObject({
      environmentId: firstEnvironmentId,
    });

    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });

    expect(reassigned).not.toBeNull();
    expect(reassigned!.executionWorkspaceSettings).toMatchObject({
      environmentId: secondEnvironmentId,
    });
  });

  it("preserves an operator-set environmentId across reassignment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const operatorEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      { id: firstEnvironmentId, companyId, name: "Env 1", driver: "ssh", status: "active", config: {} },
      { id: secondEnvironmentId, companyId, name: "Env 2", driver: "sandbox", status: "active", config: { provider: "e2b" } },
      { id: operatorEnvironmentId, companyId, name: "Operator pick", driver: "ssh", status: "active", config: {} },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId, companyId, name: "First agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId, permissions: {},
      },
      {
        id: secondAgentId, companyId, name: "Second agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId, permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId, companyId, name: "Workspace project", status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary workspace", isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Operator overrides env then reassigns",
      status: "todo",
      priority: "medium",
    });

    // Operator explicitly overrides the environmentId in a separate update.
    const overridden = await svc.update(created.id, {
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        environmentId: operatorEnvironmentId,
      },
    });
    expect(overridden!.executionWorkspaceSettings).toMatchObject({
      environmentId: operatorEnvironmentId,
    });

    // A subsequent reassignment-only update must NOT overwrite the operator's
    // explicit choice with the new assignee's default.
    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });
    expect(reassigned!.executionWorkspaceSettings).toMatchObject({
      environmentId: operatorEnvironmentId,
    });
  });

  it("clears stale assignee adapter overrides on reassignment", async () => {
    const companyId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "Chrysler AI",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "Chrysler Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const created = await svc.create(companyId, {
      assigneeAgentId: firstAgentId,
      title: "Issue with stale model override",
      status: "todo",
      priority: "medium",
      assigneeAdapterOverrides: {
        adapterConfig: { model: "claude-opus-4-7" },
      },
    });
    expect(created.assigneeAdapterOverrides).toMatchObject({
      adapterConfig: { model: "claude-opus-4-7" },
    });

    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });
    expect(reassigned).not.toBeNull();
    expect(reassigned!.assigneeAdapterOverrides).toBeNull();
  });

  it("preserves assignee adapter overrides supplied explicitly on the same reassignment update", async () => {
    const companyId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "Chrysler AI",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "Chrysler Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const created = await svc.create(companyId, {
      assigneeAgentId: firstAgentId,
      title: "Issue with override re-set on reassign",
      status: "todo",
      priority: "medium",
      assigneeAdapterOverrides: {
        adapterConfig: { model: "claude-opus-4-7" },
      },
    });

    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
      assigneeAdapterOverrides: { adapterConfig: { model: "gpt-5-codex" } },
    });
    expect(reassigned!.assigneeAdapterOverrides).toMatchObject({
      adapterConfig: { model: "gpt-5-codex" },
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  it("createChild applies parent defaults, acceptance criteria, workspace inheritance, and optional parent blocker chaining", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship child helpers",
      level: "task",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 1,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const { issue: child, parentBlockerAdded } = await svc.createChild(parentIssueId, {
      title: "Child helper",
      status: "todo",
      description: "Implement the helper.",
      acceptanceCriteria: ["Uses the parent issue as parentId", "Reuses the parent execution workspace"],
      blockParentUntilDone: true,
    });

    expect(parentBlockerAdded).toBe(true);
    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectId).toBe(projectId);
    expect(child.goalId).toBe(goalId);
    expect(child.requestDepth).toBe(2);
    expect(child.description).toContain("## Acceptance Criteria");
    expect(child.description).toContain("- Uses the parent issue as parentId");
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");

    const parentRelations = await svc.getRelationSummaries(parentIssueId);
    expect(parentRelations.blockedBy).toEqual([
      expect.objectContaining({
        id: child.id,
        title: "Child helper",
      }),
    ]);
  });

  it("stores explicit execution contracts as hidden issue data", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const executionContract = {
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "qa",
      core: {
        objective: "Verify the child lane against the source contract.",
        acceptanceChecks: ["Contract is available to QA"],
      },
      extensions: {
        qa: {
          reviewMode: "contract_fidelity",
        },
      },
    };

    const issue = await svc.create(companyId, {
      title: "QA lane",
      status: "todo",
      description: "Human-readable QA brief.",
      executionContract,
    });

    expect(issue.description).toBe("Human-readable QA brief.");
    expect(issue.executionContract).toEqual({ ...executionContract, revision: 1 });
  });

  it("blocks done until company-scoped work products satisfy declared completion evidence", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other company",
        issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    const baseContract = makeValidExecutionContract();
    const productsSvc = workProductService(db);
    const issue = await svc.create(companyId, {
      title: "Deploy and prove the delegated result",
      status: "in_review",
      executionContract: {
        ...baseContract,
        taskType: "deployment",
        core: {
          ...baseContract.core,
          acceptanceChecks: ["The preview is reachable and the QA artifact is recorded."],
          requiredOutputs: [
            { workProductType: "preview_url" },
            { workProductType: "artifact" },
          ],
        },
      },
    });

    await expect(svc.update(issue.id, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_completion_evidence_missing",
        declaredRequirementTypes: ["work_product:artifact", "work_product:preview_url"],
        missingRequirementTypes: ["work_product:artifact", "work_product:preview_url"],
        qualifyingWorkProductCount: 0,
      },
    });

    const foreignProjectId = randomUUID();
    await db.insert(projects).values({
      id: foreignProjectId,
      companyId: otherCompanyId,
      name: "Foreign project",
      status: "in_progress",
    });
    await expect(productsSvc.createForIssue(issue.id, companyId, {
      projectId: foreignProjectId,
      type: "artifact",
      provider: "paperclip",
      title: "Cross-company artifact",
      externalId: "foreign-artifact",
      status: "active",
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_work_product_reference_scope_mismatch",
        field: "projectId",
        referencedId: foreignProjectId,
      },
    });

    // Older data or direct database writes can contain a company-local product
    // row whose referenced resource belongs to another company. Completion
    // must ignore that row as evidence as well.
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: issue.id,
      projectId: foreignProjectId,
      type: "artifact",
      provider: "paperclip",
      title: "Legacy cross-company reference",
      externalId: "foreign-artifact-direct-row",
      status: "active",
    });

    // A malformed cross-company association must never satisfy the issue's
    // evidence contract, even though the database has independent FKs.
    await db.insert(issueWorkProducts).values([
      {
        companyId: otherCompanyId,
        issueId: issue.id,
        type: "preview_url",
        provider: "paperclip",
        title: "Wrong-company preview",
        url: "https://foreign.zenova.id/release-42",
        status: "active",
      },
      {
        companyId: otherCompanyId,
        issueId: issue.id,
        type: "artifact",
        provider: "paperclip",
        title: "Wrong-company QA evidence",
        status: "active",
        metadata: { sha256: "b".repeat(64) },
      },
    ]);
    await expect(svc.update(issue.id, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_completion_evidence_missing",
        missingRequirementTypes: ["work_product:artifact", "work_product:preview_url"],
        qualifyingWorkProductCount: 0,
      },
    });

    await db.insert(issueWorkProducts).values([
      {
        companyId,
        issueId: issue.id,
        type: "preview_url",
        provider: "paperclip",
        title: "Placeholder preview",
        status: "active",
      },
      {
        companyId,
        issueId: issue.id,
        type: "artifact",
        provider: "paperclip",
        title: "Placeholder QA evidence",
        status: "active",
      },
    ]);
    await expect(svc.update(issue.id, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_completion_evidence_missing",
        missingRequirementTypes: ["work_product:artifact", "work_product:preview_url"],
        qualifyingWorkProductCount: 0,
      },
    });

    const [previewProduct] = await db.insert(issueWorkProducts).values({
      companyId,
      issueId: issue.id,
      type: "preview_url",
      provider: "paperclip",
      title: "Deployment preview",
      url: "https://preview.zenova.id/release-42",
      status: "ready_for_review",
    }).returning();
    await expect(svc.update(issue.id, { status: "done" })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_completion_evidence_missing",
        missingRequirementTypes: ["work_product:artifact"],
        qualifyingWorkProductTypes: ["preview_url"],
      },
    });

    const [artifactProduct] = await db.insert(issueWorkProducts).values({
      companyId,
      issueId: issue.id,
      type: "artifact",
      provider: "paperclip",
      title: "QA evidence bundle",
      status: "active",
      metadata: { sha256: "a".repeat(64), testSuite: "focused" },
    }).returning();
    const completed = await svc.update(issue.id, { status: "done" });

    expect(completed?.status).toBe("done");
    expect(completed?.completedAt).toBeInstanceOf(Date);
    await expect(productsSvc.update(previewProduct.id, {
      url: "not-a-url",
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_completion_evidence_missing",
        missingRequirementTypes: ["work_product:preview_url"],
      },
    });
    await expect(productsSvc.update(artifactProduct.id, {
      metadata: { placeholder: true },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_completion_evidence_missing",
        missingRequirementTypes: ["work_product:artifact"],
      },
    });
    await expect(productsSvc.remove(artifactProduct.id)).rejects.toMatchObject({
      status: 422,
      details: {
        code: "issue_completion_evidence_missing",
        missingRequirementTypes: ["work_product:artifact"],
      },
    });
  });

  it("leaves simple issues and unrelated legacy done updates unaffected while freezing the completed contract", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const simpleIssue = await svc.create(companyId, {
      title: "Simple bookkeeping task",
      status: "todo",
    });
    const ordinaryContractIssue = await svc.create(companyId, {
      title: "Contract without explicit evidence",
      status: "in_review",
      executionContract: makeValidExecutionContract({ taskType: "qa" }),
    });
    const legacyContract = {
      ...makeValidExecutionContract(),
      core: {
        ...makeValidExecutionContract().core,
        acceptanceChecks: ["Evidence exists."],
        evidenceRequired: ["Durable QA proof."],
      },
    };
    await expect(svc.create(companyId, {
      title: "Invalid directly completed contract",
      status: "done",
      executionContract: legacyContract,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_completion_evidence_missing", issueId: null },
    });

    const alreadyDone = await svc.create(companyId, {
      title: "Legacy completed contract",
      status: "todo",
      executionContract: legacyContract,
    });
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, alreadyDone.id));

    expect((await svc.update(simpleIssue.id, { status: "done" }))?.status).toBe("done");
    expect((await svc.update(ordinaryContractIssue.id, { status: "done" }))?.status).toBe("done");
    await expect(svc.update(alreadyDone.id, {
      executionContract: {
        ...legacyContract,
        core: {
          ...legacyContract.core,
          requiredOutputs: [{ workProductType: "artifact" }],
        },
      },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_contract_frozen", currentRevision: 1 },
    });

    const updatedLegacyIssue = await svc.update(alreadyDone.id, {
      title: "Renamed legacy completed contract",
      priority: "high",
    });
    expect(updatedLegacyIssue).toMatchObject({
      status: "done",
      title: "Renamed legacy completed contract",
      priority: "high",
      executionContract: { revision: 1 },
    });
  });

  it("serializes completion against concurrent evidence removal", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const productsSvc = workProductService(db);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const baseContract = makeValidExecutionContract();
      const issue = await svc.create(companyId, {
        title: `Concurrent evidence race ${attempt}`,
        status: "in_review",
        executionContract: {
          ...baseContract,
          core: {
            ...baseContract.core,
            acceptanceChecks: ["The artifact remains durable at completion."],
            requiredOutputs: [{ workProductType: "artifact" }],
          },
        },
      });
      const product = await productsSvc.createForIssue(issue.id, companyId, {
        type: "artifact",
        provider: "paperclip",
        title: "Race-safe artifact",
        externalId: `artifact-${attempt}`,
        status: "active",
      });
      expect(product).not.toBeNull();

      const [completion, removal] = await Promise.allSettled([
        svc.update(issue.id, { status: "done" }),
        productsSvc.remove(product!.id),
      ]);
      const [finalIssue, finalProducts] = await Promise.all([
        svc.getById(issue.id),
        productsSvc.listForIssue(issue.id, companyId),
      ]);

      if (finalIssue?.status === "done") {
        expect(completion.status).toBe("fulfilled");
        expect(removal.status).toBe("rejected");
        expect(finalProducts.map((entry) => entry.id)).toContain(product!.id);
      } else {
        expect(completion.status).toBe("rejected");
        expect(removal.status).toBe("fulfilled");
        expect(finalProducts).toHaveLength(0);
      }
    }
  });

  it("canonicalizes accepted legacy aliases before storing a new contract revision", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issue = await svc.create(companyId, {
      title: "Canonical contract",
      status: "todo",
      executionContract: {
        schema_version: 2,
        contract_type: "delegated_task",
        task_type: "implementation",
        core: {
          objective: "Store one canonical envelope.",
          why: "Alias fields must not drift across revisions.",
          source_of_truth: { files: ["SPEC.md"] },
          acceptance_checks: ["Only canonical keys are persisted"],
          handoff_notes: {
            manager_reasoning: "The old client still writes snake_case.",
            next_action: "Execute the lane.",
          },
        },
      },
    });

    expect(issue.executionContract).toMatchObject({
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "implementation",
      revision: 1,
      core: {
        sourceOfTruth: { files: ["SPEC.md"] },
        acceptanceChecks: ["Only canonical keys are persisted"],
        handoffNotes: {
          managerReasoning: "The old client still writes snake_case.",
          nextAction: "Execute the lane.",
        },
      },
    });
    expect(JSON.stringify(issue.executionContract)).not.toContain("_version");
    expect(JSON.stringify(issue.executionContract)).not.toContain("source_of_truth");
    expect(JSON.stringify(issue.executionContract)).not.toContain("manager_reasoning");
  });

  it("rejects malformed execution contracts in direct service create and update calls", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(svc.create(companyId, {
      title: "Malformed contract",
      status: "todo",
      executionContract: { schemaVersion: "two" } as unknown as Record<string, unknown>,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "invalid_execution_contract_schema" },
    });

    const issue = await svc.create(companyId, {
      title: "Valid contract",
      status: "todo",
      executionContract: makeValidExecutionContract(),
    });
    await expect(svc.update(issue.id, {
      executionContract: { schemaVersion: 2, extensions: ["invalid"] } as unknown as Record<string, unknown>,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "invalid_execution_contract_schema" },
    });
  });

  it("revisions editable contracts and freezes them after execution begins", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issue = await svc.create(companyId, {
      title: "Revisioned contract",
      status: "todo",
      executionContract: makeValidExecutionContract(),
    });
    expect(issue.executionContract).toMatchObject({ revision: 1 });

    const updated = await svc.update(issue.id, {
      executionContract: makeValidExecutionContract({ taskType: "qa" }),
    });
    expect(updated?.executionContract).toMatchObject({
      revision: 2,
      supersedesRevision: 1,
      taskType: "qa",
    });

    const echoedCurrentRevision = await svc.update(issue.id, {
      executionContract: {
        ...(updated!.executionContract as Record<string, unknown>),
        taskType: "release",
      },
    });
    expect(echoedCurrentRevision?.executionContract).toMatchObject({
      revision: 3,
      supersedesRevision: 2,
      taskType: "release",
    });

    await svc.update(issue.id, { status: "in_review" });
    await expect(svc.update(issue.id, {
      executionContract: makeValidExecutionContract({ taskType: "implementation" }),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_contract_frozen", currentRevision: 3 },
    });
  });

  it("does not allow adding a first execution contract after execution has started", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already executing without a contract",
      status: "in_review",
      priority: "medium",
      startedAt: new Date(),
    });

    await expect(svc.update(issueId, {
      executionContract: makeValidExecutionContract(),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_contract_frozen" },
    });
  });

  it("rechecks frozen execution state after acquiring the update row lock", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const issue = await svc.create(companyId, {
      title: "Concurrent contract update",
      status: "todo",
      executionContract: makeValidExecutionContract(),
    });

    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const executionTransition = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("update");
      reportLocked();
      await release;
      await tx.update(issues).set({
        status: "in_review",
        startedAt: new Date(),
      }).where(eq(issues.id, issue.id));
    });

    await locked;
    const contractUpdate = svc.update(issue.id, {
      executionContract: makeValidExecutionContract({ taskType: "qa" }),
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseLock();
    await executionTransition;

    expect((await contractUpdate).error).toMatchObject({
      status: 409,
      details: { code: "execution_contract_frozen" },
    });
    expect((await svc.getById(issue.id))?.executionContract).toMatchObject({
      revision: 1,
      taskType: "implementation",
    });
  });

  it("validates agent-origin child contracts again when they are updated", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    const creatorAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: creatorAgentId,
      companyId,
      name: "Manager",
      role: "manager",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    });
    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      title: "Agent child",
      status: "todo",
      createdByAgentId: creatorAgentId,
      executionContract: makeValidExecutionContract(),
    });

    await expect(svc.update(child.id, {
      executionContract: {
        schemaVersion: 2,
        contractType: "delegated_task",
        taskType: "implementation",
        core: { objective: "Missing the rest of the manager handoff." },
      },
      actorUserId: "local-board",
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "invalid_execution_contract" }),
    });
  });

  it("copies legacy markdown execution contracts into hidden data while preserving descriptions on create", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const description = [
      "Build the handoff storage.",
      "",
      "## Execution Contract",
      "",
      "```json",
      JSON.stringify({
        schemaVersion: 2,
        contractType: "delegated_task",
        taskType: "implementation",
        core: {
          objective: "Store execution contracts outside descriptions.",
          acceptanceChecks: ["Issue description stays human-readable"],
        },
      }),
      "```",
      "",
      "## Acceptance Criteria",
      "",
      "- The contract remains visible in the description",
    ].join("\n");

    const issue = await svc.create(companyId, {
      title: "Implementation lane",
      status: "todo",
      description,
    });

    expect(issue.description).toBe(description);
    expect(issue.executionContract).toMatchObject({
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "implementation",
    });
  });

  it("does not blank descriptions that only contain a legacy markdown execution contract", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const description = [
      "## Execution Contract",
      "",
      "```json",
      JSON.stringify(makeValidExecutionContract({
        core: {
          objective: "Preserve human-entered issue detail.",
          why: "Humans should not lose the prompt they wrote in the issue body.",
          sourceOfTruth: {
            links: ["https://paper.zenova.id/PAP/issues/PAP-100"],
          },
          acceptanceChecks: ["The description remains visible after create."],
          handoffNotes: {
            managerReasoning: "The inline contract was entered in the description and must not disappear.",
          },
        },
      })),
      "```",
    ].join("\n");

    const issue = await svc.create(companyId, {
      title: "Contract-only description",
      status: "todo",
      description,
    });

    expect(issue.description).toBe(description);
    expect(issue.executionContract).toMatchObject({
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "implementation",
    });
  });

  it("preserves descriptions when unrelated fields are updated", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const description = [
      "Human-visible validation description.",
      "",
      "## Execution Contract",
      "",
      "```json",
      JSON.stringify(makeValidExecutionContract()),
      "```",
    ].join("\n");

    const issue = await svc.create(companyId, {
      title: "Preserve description on patch",
      status: "backlog",
      priority: "low",
      description,
    });

    const updated = await svc.update(issue.id, {
      priority: "high",
    });

    expect(updated?.priority).toBe("high");
    expect(updated?.description).toBe(description);
    expect(updated?.executionContract).toMatchObject({
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "implementation",
    });
  });

  it("treats description-only edits with the same inline legacy contract as semantic no-ops", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const legacyContract = makeValidExecutionContract();
    const preStartIssueId = randomUUID();
    const postStartIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: preStartIssueId,
        companyId,
        title: "Legacy contract before execution",
        description: descriptionWithInlineExecutionContract("Original brief.", legacyContract),
        executionContract: legacyContract,
        status: "todo",
        priority: "medium",
      },
      {
        id: postStartIssueId,
        companyId,
        title: "Legacy contract after execution",
        description: descriptionWithInlineExecutionContract("Original active brief.", legacyContract),
        executionContract: { ...legacyContract, revision: 1 },
        status: "in_review",
        priority: "medium",
        startedAt: new Date(),
      },
    ]);

    const preStart = await svc.update(preStartIssueId, {
      description: descriptionWithInlineExecutionContract("Edited brief.", legacyContract),
    });
    const postStart = await svc.update(postStartIssueId, {
      description: descriptionWithInlineExecutionContract("Edited active brief.", legacyContract),
    });

    expect(preStart?.description).toContain("Edited brief.");
    expect(preStart?.executionContract).toEqual(legacyContract);
    expect(postStart?.description).toContain("Edited active brief.");
    expect(postStart?.executionContract).toEqual({ ...legacyContract, revision: 1 });
  });

  it("rejects agent-created child issues without a valid execution contract", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.create(companyId, {
      parentId: parentIssueId,
      title: "Direct child without contract",
      status: "todo",
      priority: "medium",
      createdByAgentId: randomUUID(),
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "invalid_execution_contract",
        missingExecutionContract: true,
        warnings: ["executionContract is required for agent-created child issues"],
      },
    });

    await expect(svc.createChild(parentIssueId, {
      title: "Helper child without contract",
      status: "todo",
      actorAgentId: randomUUID(),
    })).rejects.toMatchObject({
      status: 422,
      details: {
        code: "invalid_execution_contract",
        missingExecutionContract: true,
        warnings: ["executionContract is required for agent-created child issues"],
      },
    });
  });

  it("allows human-created child issues to omit execution contracts", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    });

    const directChild = await svc.create(companyId, {
      parentId: parentIssueId,
      title: "Human direct child",
      status: "todo",
      priority: "medium",
      createdByUserId: "board-user",
    });
    const helperChild = await svc.createChild(parentIssueId, {
      title: "Human helper child",
      status: "todo",
      actorUserId: "board-user",
    });

    expect(directChild.parentId).toBe(parentIssueId);
    expect(directChild.executionContract).toBeNull();
    expect(helperChild.issue.parentId).toBe(parentIssueId);
    expect(helperChild.issue.executionContract).toBeNull();
  });

  it("allows agent-created child issues with legacy markdown execution contracts", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    });

    const description = [
      "Human-readable brief.",
      "",
      "## Execution Contract",
      "",
      "```json",
      JSON.stringify(makeValidExecutionContract()),
      "```",
    ].join("\n");

    const { issue } = await svc.createChild(parentIssueId, {
      title: "Legacy contract child",
      status: "todo",
      actorAgentId: randomUUID(),
      description,
    });

    expect(issue.description).toBe(description);
    expect(issue.executionContract).toMatchObject({
      schemaVersion: 2,
      contractType: "delegated_task",
      taskType: "implementation",
    });
  });

  it("clamps helper-created child requestDepth to the safe maximum", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship child helpers",
      level: "task",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH,
    });

    const { issue: child } = await svc.createChild(parentIssueId, {
      title: "Child helper",
      status: "todo",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 100,
    });

    expect(child.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  it("prevents execution lanes from creating grandchildren", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const otherParentIssueId = randomUUID();
    const leafIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Main parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: childIssueId,
        companyId,
        parentId: parentIssueId,
        title: "Execution lane",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherParentIssueId,
        companyId,
        title: "Other main parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: leafIssueId,
        companyId,
        title: "Leaf main issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await expect(svc.create(companyId, {
      parentId: childIssueId,
      title: "Grandchild attempt",
      status: "todo",
      priority: "medium",
    })).rejects.toMatchObject({ status: 422 });

    await expect(svc.createChild(childIssueId, {
      title: "Helper grandchild attempt",
      status: "todo",
    })).rejects.toMatchObject({ status: 422 });

    await expect(svc.update(leafIssueId, {
      parentId: childIssueId,
    })).rejects.toMatchObject({ status: 422 });

    await expect(svc.update(parentIssueId, {
      parentId: otherParentIssueId,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("cannot become child issues"),
    });
  });

  it("enforces same-issue-only topology through direct, helper, and reparent creation paths", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    const movableIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Same issue only",
        status: "todo",
        priority: "medium",
        executionContract: {
          schemaVersion: 1,
          revision: 1,
          extensions: { aiFactory: { topologyMode: "same_issue_only" } },
        },
      },
      {
        id: movableIssueId,
        companyId,
        title: "Movable issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const expectedError = {
      status: 422,
      details: expect.objectContaining({
        code: "factory_policy_conflict",
        rule: "issue_topology",
        topologyMode: "same_issue_only",
      }),
    };
    await expect(svc.create(companyId, {
      parentId: parentIssueId,
      title: "Direct bypass attempt",
      status: "todo",
    })).rejects.toMatchObject(expectedError);
    await expect(svc.createChild(parentIssueId, {
      title: "Helper bypass attempt",
      status: "todo",
    })).rejects.toMatchObject(expectedError);
    await expect(svc.update(movableIssueId, {
      parentId: parentIssueId,
    })).rejects.toMatchObject(expectedError);
  });

  it("caps direct execution lanes under a parent issue", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Main parent",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issues).values(
      Array.from({ length: MAX_DIRECT_CHILD_ISSUES_PER_PARENT }, (_, index) => ({
        id: randomUUID(),
        companyId,
        parentId: parentIssueId,
        title: `Execution lane ${index + 1}`,
        status: "todo",
        priority: "medium",
      })),
    );

    await expect(svc.create(companyId, {
      parentId: parentIssueId,
      title: "One lane too many",
      status: "todo",
      priority: "medium",
    })).rejects.toMatchObject({ status: 422 });
  });

  it("serializes concurrent child creation at the direct-lane cap", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Concurrent lane parent",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issues).values(
      Array.from({ length: MAX_DIRECT_CHILD_ISSUES_PER_PARENT - 1 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        parentId: parentIssueId,
        title: `Existing lane ${index + 1}`,
        status: "todo",
        priority: "medium",
      })),
    );

    const attempts = await Promise.allSettled([
      svc.create(companyId, {
        parentId: parentIssueId,
        title: "Concurrent lane A",
        status: "todo",
      }),
      svc.create(companyId, {
        parentId: parentIssueId,
        title: "Concurrent lane B",
        status: "todo",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { status: 422 },
    });

    const children = await svc.list(companyId, { parentId: parentIssueId });
    expect(children).toHaveLength(MAX_DIRECT_CHILD_ISSUES_PER_PARENT);
  });

  it("serializes concurrent creation against the frozen factory cap even when the contract is looser", async () => {
    const companyId = randomUUID();
    const parentIssueId = randomUUID();
    const coordinatorAgentId = randomUUID();
    const policyHash = factoryPolicyContentHash(DEFAULT_FACTORY_POLICY_V1);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Frozen single-lane control",
      status: "todo",
      priority: "medium",
      executionContract: {
        schemaVersion: 2,
        revision: 1,
        extensions: {
          aiFactory: {
            topologyMode: "direct_execution_lanes",
            maxExecutionLanes: 10,
          },
        },
      },
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        factory: {
          schemaVersion: 1,
          laneKind: "control",
          topologyMode: "single_execution_lane",
          controlIssueId: null,
          coordinator: { type: "agent", agentId: coordinatorAgentId },
          policyKey: "company/acme/ai-factory-policy",
          policyVersion: "1",
          policyHash,
          maxExecutionLanes: 1,
          policySnapshot: DEFAULT_FACTORY_POLICY_V1,
        },
      },
    });

    const qaAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const selectedPolicyStages = DEFAULT_FACTORY_POLICY_V1.stages
      .filter((stage) => factoryPolicyStageIsSelected(stage, false));
    const laneExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: selectedPolicyStages.map((stage, index) => ({
        id: randomUUID(),
        key: stage.key,
        type: stage.type,
        role: stage.role,
        independent: stage.independent ?? false,
        returnToStageKey: factoryStageReturnTarget(selectedPolicyStages, index),
        evidenceGates: factoryStageEvidenceGates(stage),
        approvalsNeeded: 1 as const,
        participants: [{
          id: randomUUID(),
          type: "agent" as const,
          agentId: stage.role === "qa"
            ? qaAgentId
            : stage.role === "engineer"
              ? engineerAgentId
              : coordinatorAgentId,
        }],
      })),
      factory: {
        schemaVersion: 1,
        laneKind: "execution",
        topologyMode: "same_issue_only",
        controlIssueId: parentIssueId,
        coordinator: { type: "agent", agentId: coordinatorAgentId },
        policyKey: "company/acme/ai-factory-policy",
        policyVersion: "1",
        policyHash,
        maxExecutionLanes: 1,
        policySnapshot: DEFAULT_FACTORY_POLICY_V1,
        production: false,
      },
    } satisfies IssueExecutionPolicy;

    const attempts = await Promise.allSettled([
      svc.create(companyId, {
        parentId: parentIssueId,
        title: "Frozen lane A",
        status: "todo",
        executionPolicy: laneExecutionPolicy,
        factoryManagedCreate: authorizeFactoryManagedCreate(policyHash, parentIssueId),
      }),
      svc.create(companyId, {
        parentId: parentIssueId,
        title: "Frozen lane B",
        status: "todo",
        executionPolicy: laneExecutionPolicy,
        factoryManagedCreate: authorizeFactoryManagedCreate(policyHash, parentIssueId),
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: {
        status: 422,
        details: expect.objectContaining({
          code: "factory_policy_conflict",
          rule: "max_execution_lanes",
          maxExecutionLanes: 1,
          policySource: "execution_policy",
        }),
      },
    });
    expect(await svc.list(companyId, { parentId: parentIssueId })).toHaveLength(1);
  });

  it("requires the typed lane route for every child of a factory control issue", async () => {
    const companyId = randomUUID();
    const controlIssueId = randomUUID();
    const movableIssueId = randomUUID();
    const coordinatorAgentId = randomUUID();
    const policyHash = factoryPolicyContentHash(DEFAULT_FACTORY_POLICY_V1);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: controlIssueId,
        companyId,
        title: "Factory control",
        status: "todo",
        priority: "medium",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          factory: {
            schemaVersion: 1,
            laneKind: "control",
            topologyMode: "single_execution_lane",
            controlIssueId: null,
            coordinator: { type: "agent", agentId: coordinatorAgentId },
            policyKey: "company/acme/ai-factory-policy",
            policyVersion: "1",
            policyHash,
            maxExecutionLanes: 1,
            policySnapshot: DEFAULT_FACTORY_POLICY_V1,
          },
        },
      },
      {
        id: movableIssueId,
        companyId,
        title: "Ordinary issue",
        status: "todo",
        priority: "medium",
      },
    ]);
    const expected = {
      status: 422,
      details: expect.objectContaining({
        code: "factory_managed_route_required",
        managedRoute: `POST /api/issues/${controlIssueId}/execution-lanes`,
      }),
    };

    await expect(svc.create(companyId, {
      parentId: controlIssueId,
      title: "Generic bypass",
      status: "todo",
    })).rejects.toMatchObject(expected);
    await expect(svc.createChild(controlIssueId, {
      title: "Helper bypass",
      status: "todo",
    })).rejects.toMatchObject(expected);
    await expect(svc.update(movableIssueId, { parentId: controlIssueId })).rejects.toMatchObject(expected);
    expect(await svc.list(companyId, { parentId: controlIssueId })).toHaveLength(0);
  });

  it("keeps a pinned factory issue in its authorized project and visibility boundary", async () => {
    const companyId = randomUUID();
    const controlIssueId = randomUUID();
    const coordinatorAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: controlIssueId,
      companyId,
      projectId: null,
      visibility: "company",
      title: "Pinned factory control",
      status: "todo",
      priority: "medium",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        factory: {
          schemaVersion: 1,
          laneKind: "control",
          topologyMode: "single_execution_lane",
          controlIssueId: null,
          coordinator: { type: "agent", agentId: coordinatorAgentId },
          policyKey: "company/acme/ai-factory-policy",
          policyVersion: "1",
          policyHash: "deadbeef",
          maxExecutionLanes: 1,
        },
      },
    });

    for (const patch of [
      { projectId: randomUUID() },
      { visibility: "private" },
    ]) {
      await expect(svc.update(controlIssueId, patch)).rejects.toMatchObject({
        status: 409,
        details: expect.objectContaining({ code: "factory_access_boundary_frozen" }),
      });
    }

    await expect(svc.update(controlIssueId, { priority: "high" })).resolves.toMatchObject({
      projectId: null,
      visibility: "company",
      priority: "high",
    });
  });

  it("rejects an authorized transition when a legacy execution snapshot was forged", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const controlIssueId = randomUUID();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const participantAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Forged legacy execution lane",
      status: "in_progress",
      priority: "medium",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          key: "contract",
          type: "work",
          role: "cto",
          independent: false,
          returnToStageKey: null,
          evidenceGates: [],
          approvalsNeeded: 1,
          participants: [{ id: participantId, type: "agent", agentId: participantAgentId }],
        }],
        factory: {
          schemaVersion: 1,
          laneKind: "execution",
          topologyMode: "same_issue_only",
          controlIssueId,
          coordinator: { type: "agent", agentId: participantAgentId },
          policyKey: "company/acme/ai-factory-policy",
          policyVersion: "1",
          policyHash: "deadbeef",
          maxExecutionLanes: 1,
          policySnapshot: DEFAULT_FACTORY_POLICY_V1,
          production: false,
        },
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "work",
        stageRevision: 0,
        currentStageActivatedAt: "2026-07-17T00:00:00.000Z",
        completedStageRevisions: {},
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: participantAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    });

    await expect(svc.update(issueId, {
      status: "in_review",
      factoryManagedTransition: authorizeFactoryManagedTransition(0, null),
    })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        code: "factory_snapshot_inconsistent",
        rule: "policy_hash",
      }),
    });

    expect(await svc.getById(issueId)).toMatchObject({
      status: "in_progress",
      executionState: expect.objectContaining({ stageRevision: 0 }),
    });
  });

  it("checks completed factory stages against exact delivery lineage inside the transition transaction", async () => {
    const companyId = randomUUID();
    const controlIssueId = randomUUID();
    const laneIssueId = randomUUID();
    const ctoAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const candidateSha = "5fa761a27c7d8cfc285057e6997b04b9831a07c4";
    const selectedPolicyStages = DEFAULT_FACTORY_POLICY_V1.stages
      .filter((stage) => factoryPolicyStageIsSelected(stage, false));
    const agentForRole = (role: string) => role === "qa"
      ? qaAgentId
      : role === "engineer"
        ? engineerAgentId
        : ctoAgentId;
    const stages = selectedPolicyStages.map((stage, index) => ({
      id: randomUUID(),
      key: stage.key,
      type: stage.type,
      role: stage.role,
      independent: stage.independent ?? false,
      returnToStageKey: factoryStageReturnTarget(selectedPolicyStages, index),
      evidenceGates: factoryStageEvidenceGates(stage),
      approvalsNeeded: 1 as const,
      participants: [{ id: randomUUID(), type: "agent" as const, agentId: agentForRole(stage.role) }],
    }));
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages,
      factory: {
        schemaVersion: 1,
        laneKind: "execution",
        topologyMode: "same_issue_only",
        controlIssueId,
        coordinator: { type: "agent", agentId: ctoAgentId },
        policyKey: "company/acme/ai-factory-policy",
        policyVersion: String(DEFAULT_FACTORY_POLICY_V1.version),
        policyHash: factoryPolicyContentHash(DEFAULT_FACTORY_POLICY_V1),
        maxExecutionLanes: effectiveFactoryExecutionLaneMaximum(DEFAULT_FACTORY_POLICY_V1),
        policySnapshot: DEFAULT_FACTORY_POLICY_V1,
        production: false,
      },
    } satisfies IssueExecutionPolicy;
    const contractStage = stages[0]!;
    const implementationStage = stages[1]!;
    const qaStage = stages[2]!;
    const implementationActivatedAt = "2026-07-17T01:00:00.000Z";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ctoAgentId, companyId, name: "CTO", role: "cto", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: engineerAgentId, companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values([
      {
        id: controlIssueId,
        companyId,
        title: "Factory control",
        status: "in_progress",
        priority: "medium",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          factory: {
            schemaVersion: 1,
            laneKind: "control",
            topologyMode: "single_execution_lane",
            controlIssueId: null,
            coordinator: executionPolicy.factory.coordinator,
            policyKey: executionPolicy.factory.policyKey,
            policyVersion: executionPolicy.factory.policyVersion,
            policyHash: executionPolicy.factory.policyHash,
            maxExecutionLanes: executionPolicy.factory.maxExecutionLanes,
            policySnapshot: DEFAULT_FACTORY_POLICY_V1,
          },
        },
      },
      {
        id: laneIssueId,
        companyId,
        parentId: controlIssueId,
        title: "Factory lane",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: engineerAgentId,
        executionPolicy,
        executionState: {
          status: "pending",
          currentStageId: implementationStage.id,
          currentStageIndex: 1,
          currentStageType: implementationStage.type,
          stageRevision: 2,
          currentStageActivatedAt: implementationActivatedAt,
          completedStageRevisions: { [contractStage.id]: 1 },
          currentParticipant: { type: "agent", agentId: engineerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: ctoAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [contractStage.id],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
        },
      },
    ]);
    await db.insert(deliveryEvents).values({
      companyId,
      issueId: laneIssueId,
      stage: "implementation",
      state: "succeeded",
      candidateSha,
      sourceKind: "agent_submission",
      authority: "agent_claim",
      metadata: {
        paperclipFactory: {
          version: 1,
          stageId: implementationStage.id,
          stageKey: implementationStage.key,
          // Deliberately stale: this evidence came from a prior activation.
          stageRevision: 1,
          stageActivatedAt: "2026-07-17T00:00:00.000Z",
          participant: { type: "agent", agentId: engineerAgentId, userId: null },
        },
      },
    });

    const nextExecutionState = {
      status: "pending" as const,
      currentStageId: qaStage.id,
      currentStageIndex: 2,
      currentStageType: qaStage.type,
      stageRevision: 3,
      currentStageActivatedAt: "2026-07-17T02:00:00.000Z",
      completedStageRevisions: { [contractStage.id]: 1, [implementationStage.id]: 2 },
      currentParticipant: { type: "agent" as const, agentId: qaAgentId, userId: null },
      returnAssignee: { type: "agent" as const, agentId: ctoAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [contractStage.id, implementationStage.id],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
    };
    const transition = {
      assigneeAgentId: qaAgentId,
      executionState: nextExecutionState,
      factoryManagedTransition: authorizeFactoryManagedTransition(2, null),
    };
    await expect(svc.update(laneIssueId, transition)).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "delivery_evidence_gate_unsatisfied",
        missing: expect.arrayContaining([
          expect.objectContaining({ reason: "stale_event" }),
        ]),
      }),
    });
    expect(await svc.getById(laneIssueId)).toMatchObject({
      assigneeAgentId: engineerAgentId,
      executionState: expect.objectContaining({ stageRevision: 2 }),
    });

    await db.insert(deliveryEvents).values({
      companyId,
      issueId: laneIssueId,
      stage: "implementation",
      state: "succeeded",
      candidateSha,
      sourceKind: "agent_submission",
      authority: "agent_claim",
      metadata: {
        paperclipFactory: {
          version: 1,
          stageId: implementationStage.id,
          stageKey: implementationStage.key,
          stageRevision: 2,
          stageActivatedAt: implementationActivatedAt,
          participant: { type: "agent", agentId: engineerAgentId, userId: null },
        },
      },
      observedAt: new Date("2026-07-17T01:30:00.000Z"),
    });
    await db.insert(deliveryEvents).values({
      companyId,
      issueId: laneIssueId,
      stage: "ci",
      state: "succeeded",
      candidateSha,
      provider: "github",
      providerExternalId: "ci-current-implementation",
      providerUrl: "https://github.example/actions/runs/ci-current-implementation",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: {
        paperclipFactory: {
          version: 1,
          stageId: implementationStage.id,
          stageKey: implementationStage.key,
          stageRevision: 2,
          stageActivatedAt: implementationActivatedAt,
          participant: { type: "agent", agentId: engineerAgentId, userId: null },
        },
      },
      observedAt: new Date("2026-07-17T01:31:00.000Z"),
    });
    await expect(svc.update(laneIssueId, transition)).resolves.toMatchObject({
      assigneeAgentId: qaAgentId,
      executionState: expect.objectContaining({
        currentStageId: qaStage.id,
        stageRevision: 3,
        completedStageIds: [contractStage.id, implementationStage.id],
      }),
    });
  });

  it("requires a board-accepted candidate-bound confirmation before production deployment starts", async () => {
    const companyId = randomUUID();
    const controlIssueId = randomUUID();
    const laneIssueId = randomUUID();
    const ctoAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const devopsAgentId = randomUUID();
    const candidateSha = "5fa761a27c7d8cfc285057e6997b04b9831a07c4";
    const selectedPolicyStages = DEFAULT_FACTORY_POLICY_V1.stages
      .filter((stage) => factoryPolicyStageIsSelected(stage, true));
    const agentForRole = (role: string) => role === "qa"
      ? qaAgentId
      : role === "engineer"
        ? engineerAgentId
        : role === "devops"
          ? devopsAgentId
          : ctoAgentId;
    const stages = selectedPolicyStages.map((stage, index) => ({
      id: randomUUID(),
      key: stage.key,
      type: stage.type,
      role: stage.role,
      independent: stage.independent ?? false,
      returnToStageKey: factoryStageReturnTarget(selectedPolicyStages, index),
      evidenceGates: factoryStageEvidenceGates(stage),
      approvalsNeeded: 1 as const,
      participants: [{ id: randomUUID(), type: "agent" as const, agentId: agentForRole(stage.role) }],
    }));
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages,
      factory: {
        schemaVersion: 1,
        laneKind: "execution",
        topologyMode: "same_issue_only",
        controlIssueId,
        coordinator: { type: "agent", agentId: ctoAgentId },
        policyKey: "company/acme/ai-factory-policy",
        policyVersion: String(DEFAULT_FACTORY_POLICY_V1.version),
        policyHash: factoryPolicyContentHash(DEFAULT_FACTORY_POLICY_V1),
        maxExecutionLanes: effectiveFactoryExecutionLaneMaximum(DEFAULT_FACTORY_POLICY_V1),
        policySnapshot: DEFAULT_FACTORY_POLICY_V1,
        production: true,
      },
    } satisfies IssueExecutionPolicy;
    const contractStage = stages.find((stage) => stage.key === "contract")!;
    const implementationStage = stages.find((stage) => stage.key === "implementation")!;
    const qaStage = stages.find((stage) => stage.key === "independent_qa")!;
    const acceptanceStage = stages.find((stage) => stage.key === "technical_acceptance")!;
    const deploymentStage = stages.find((stage) => stage.key === "deployment")!;
    const liveQaStage = stages.find((stage) => stage.key === "live_qa")!;
    const finalAcceptanceStage = stages.find((stage) => stage.key === "final_acceptance")!;
    const implementationActivatedAt = "2026-07-17T01:00:00.000Z";
    const qaActivatedAt = "2026-07-17T02:00:00.000Z";
    const deploymentActivatedAt = "2026-07-17T04:00:00.000Z";
    const liveQaActivatedAt = "2026-07-17T05:00:00.000Z";
    const finalAcceptanceActivatedAt = "2026-07-17T06:00:00.000Z";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ctoAgentId, companyId, name: "CTO", role: "cto", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: engineerAgentId, companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: devopsAgentId, companyId, name: "DevOps", role: "devops", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values([
      {
        id: controlIssueId,
        companyId,
        title: "Factory control",
        status: "in_progress",
        priority: "medium",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [],
          factory: {
            schemaVersion: 1,
            laneKind: "control",
            topologyMode: "single_execution_lane",
            controlIssueId: null,
            coordinator: executionPolicy.factory.coordinator,
            policyKey: executionPolicy.factory.policyKey,
            policyVersion: executionPolicy.factory.policyVersion,
            policyHash: executionPolicy.factory.policyHash,
            maxExecutionLanes: executionPolicy.factory.maxExecutionLanes,
            policySnapshot: DEFAULT_FACTORY_POLICY_V1,
          },
        },
      },
      {
        id: laneIssueId,
        companyId,
        parentId: controlIssueId,
        title: "Production factory lane",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: ctoAgentId,
        executionPolicy,
        executionState: {
          status: "pending",
          currentStageId: acceptanceStage.id,
          currentStageIndex: 3,
          currentStageType: acceptanceStage.type,
          stageRevision: 4,
          currentStageActivatedAt: "2026-07-17T03:00:00.000Z",
          completedStageRevisions: {
            [contractStage.id]: 1,
            [implementationStage.id]: 2,
            [qaStage.id]: 3,
          },
          currentParticipant: { type: "agent", agentId: ctoAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: ctoAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [contractStage.id, implementationStage.id, qaStage.id],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
        },
      },
    ]);
    await db.insert(deliveryEvents).values([
      {
        companyId,
        issueId: laneIssueId,
        stage: "implementation",
        state: "succeeded",
        candidateSha,
        sourceKind: "agent_submission",
        authority: "agent_claim",
        metadata: {
          paperclipFactory: {
            version: 1,
            stageId: implementationStage.id,
            stageKey: implementationStage.key,
            stageRevision: 2,
            stageActivatedAt: implementationActivatedAt,
            participant: { type: "agent", agentId: engineerAgentId, userId: null },
          },
        },
      },
      {
        companyId,
        issueId: laneIssueId,
        stage: "ci",
        state: "succeeded",
        candidateSha,
        provider: "github",
        providerExternalId: "ci-production-candidate",
        providerUrl: "https://github.example/actions/runs/ci-production-candidate",
        sourceKind: "provider_observation",
        authority: "provider_verified",
        metadata: {
          paperclipFactory: {
            version: 1,
            stageId: implementationStage.id,
            stageKey: implementationStage.key,
            stageRevision: 2,
            stageActivatedAt: implementationActivatedAt,
            participant: { type: "agent", agentId: engineerAgentId, userId: null },
          },
        },
      },
      {
        companyId,
        issueId: laneIssueId,
        stage: "functional_qa",
        state: "succeeded",
        candidateSha,
        sourceKind: "agent_submission",
        authority: "agent_claim",
        metadata: {
          paperclipFactory: {
            version: 1,
            stageId: qaStage.id,
            stageKey: qaStage.key,
            stageRevision: 3,
            stageActivatedAt: qaActivatedAt,
            participant: { type: "agent", agentId: qaAgentId, userId: null },
          },
        },
      },
    ]);

    const decisionId = randomUUID();
    const nextExecutionState = {
      status: "pending" as const,
      currentStageId: deploymentStage.id,
      currentStageIndex: 4,
      currentStageType: deploymentStage.type,
      stageRevision: 5,
      currentStageActivatedAt: deploymentActivatedAt,
      completedStageRevisions: {
        [contractStage.id]: 1,
        [implementationStage.id]: 2,
        [qaStage.id]: 3,
        [acceptanceStage.id]: 4,
      },
      currentParticipant: { type: "agent" as const, agentId: devopsAgentId, userId: null },
      returnAssignee: { type: "agent" as const, agentId: ctoAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [contractStage.id, implementationStage.id, qaStage.id, acceptanceStage.id],
      lastDecisionId: decisionId,
      lastDecisionOutcome: "approved" as const,
      monitor: null,
    };
    const transition = {
      status: "in_progress",
      assigneeAgentId: devopsAgentId,
      executionState: nextExecutionState,
      factoryManagedTransition: authorizeFactoryManagedTransition(4, decisionId),
    };
    await expect(svc.update(laneIssueId, transition)).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "factory_irreversible_action_approval_required",
        candidateSha,
      }),
    });
    expect(await svc.getById(laneIssueId)).toMatchObject({
      status: "in_review",
      assigneeAgentId: ctoAgentId,
      executionState: expect.objectContaining({ stageRevision: 4 }),
    });
    expect(
      await db.select().from(deliveryEvents).where(eq(deliveryEvents.issueId, laneIssueId)),
    ).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "technical_acceptance", state: "accepted" }),
    ]));

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: laneIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      idempotencyKey: `factory-deploy:${candidateSha}`,
      createdByAgentId: ctoAgentId,
      resolvedByUserId: "board-user",
      payload: {
        version: 1,
        prompt: "Authorize this exact production candidate for deployment?",
        target: {
          type: "custom",
          key: FACTORY_IRREVERSIBLE_ACTION_APPROVAL_TARGET_KEY,
          revisionId: candidateSha,
          label: `Production candidate ${candidateSha.slice(0, 12)}`,
        },
        capabilityPreflight: {
          version: 1,
          reasonKind: "irreversible_action",
          checks: [{
            capability: "production deployment",
            status: "available",
            evidence: "Provider credentials and rollback path were checked.",
          }],
          alternativesConsidered: ["Stop at a non-production preview."],
          minimumDecision: "Approve or reject this exact candidate for production.",
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedAt: new Date(),
    });

    await expect(svc.update(laneIssueId, transition)).resolves.toMatchObject({
      status: "in_progress",
      assigneeAgentId: devopsAgentId,
      executionState: expect.objectContaining({
        currentStageId: deploymentStage.id,
        stageRevision: 5,
      }),
    });
    expect(
      await db.select().from(deliveryEvents).where(eq(deliveryEvents.issueId, laneIssueId)),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "technical_acceptance",
        state: "accepted",
        candidateSha,
        sourceKind: "paperclip_action",
        authority: "paperclip_verified",
        metadata: expect.objectContaining({ decisionId }),
      }),
    ]));

    await db.insert(deliveryEvents).values({
      companyId,
      issueId: laneIssueId,
      stage: "deployment",
      state: "succeeded",
      candidateSha,
      environment: "production",
      provider: "cloudflare",
      providerExternalId: "production-deployment-1",
      providerUrl: "https://paperclip.example/deployments/production-deployment-1",
      sourceKind: "provider_observation",
      authority: "provider_verified",
      metadata: {
        paperclipFactory: {
          version: 1,
          stageId: deploymentStage.id,
          stageKey: deploymentStage.key,
          stageRevision: 5,
          stageActivatedAt: deploymentActivatedAt,
          participant: { type: "agent", agentId: devopsAgentId, userId: null },
        },
      },
    });
    const liveQaState = {
      status: "pending" as const,
      currentStageId: liveQaStage.id,
      currentStageIndex: 5,
      currentStageType: liveQaStage.type,
      stageRevision: 6,
      currentStageActivatedAt: liveQaActivatedAt,
      completedStageRevisions: {
        ...nextExecutionState.completedStageRevisions,
        [deploymentStage.id]: 5,
      },
      currentParticipant: { type: "agent" as const, agentId: qaAgentId, userId: null },
      returnAssignee: { type: "agent" as const, agentId: ctoAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [...nextExecutionState.completedStageIds, deploymentStage.id],
      lastDecisionId: decisionId,
      lastDecisionOutcome: "approved" as const,
      monitor: null,
    };
    await expect(svc.update(laneIssueId, {
      status: "in_review",
      assigneeAgentId: qaAgentId,
      executionState: liveQaState,
      factoryManagedTransition: authorizeFactoryManagedTransition(5, null),
    })).resolves.toMatchObject({
      status: "in_review",
      assigneeAgentId: qaAgentId,
      executionState: expect.objectContaining({
        currentStageId: liveQaStage.id,
        stageRevision: 6,
      }),
    });

    await db.insert(deliveryEvents).values({
      companyId,
      issueId: laneIssueId,
      stage: "smoke",
      state: "succeeded",
      candidateSha,
      environment: "production",
      provider: "cloudflare",
      providerExternalId: "production-deployment-1",
      providerUrl: "https://paperclip.example/deployments/production-deployment-1",
      sourceKind: "agent_submission",
      authority: "agent_claim",
      metadata: {
        paperclipFactory: {
          version: 1,
          stageId: liveQaStage.id,
          stageKey: liveQaStage.key,
          stageRevision: 6,
          stageActivatedAt: liveQaActivatedAt,
          participant: { type: "agent", agentId: qaAgentId, userId: null },
        },
      },
    });
    const liveQaDecisionId = randomUUID();
    const finalAcceptanceState = {
      status: "pending" as const,
      currentStageId: finalAcceptanceStage.id,
      currentStageIndex: 6,
      currentStageType: finalAcceptanceStage.type,
      stageRevision: 7,
      currentStageActivatedAt: finalAcceptanceActivatedAt,
      completedStageRevisions: {
        ...liveQaState.completedStageRevisions,
        [liveQaStage.id]: 6,
      },
      currentParticipant: { type: "agent" as const, agentId: ctoAgentId, userId: null },
      returnAssignee: { type: "agent" as const, agentId: ctoAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [...liveQaState.completedStageIds, liveQaStage.id],
      lastDecisionId: liveQaDecisionId,
      lastDecisionOutcome: "approved" as const,
      monitor: null,
    };
    await expect(svc.update(laneIssueId, {
      assigneeAgentId: ctoAgentId,
      executionState: finalAcceptanceState,
      factoryManagedTransition: authorizeFactoryManagedTransition(6, liveQaDecisionId),
    })).resolves.toMatchObject({
      status: "in_review",
      assigneeAgentId: ctoAgentId,
      executionState: expect.objectContaining({
        currentStageId: finalAcceptanceStage.id,
        stageRevision: 7,
      }),
    });

    const finalDecisionId = randomUUID();
    const completedState = {
      status: "completed" as const,
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      stageRevision: 7,
      currentStageActivatedAt: null,
      completedStageRevisions: {
        ...finalAcceptanceState.completedStageRevisions,
        [finalAcceptanceStage.id]: 7,
      },
      currentParticipant: null,
      returnAssignee: { type: "agent" as const, agentId: ctoAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [...finalAcceptanceState.completedStageIds, finalAcceptanceStage.id],
      lastDecisionId: finalDecisionId,
      lastDecisionOutcome: "approved" as const,
      monitor: null,
    };
    await expect(svc.update(laneIssueId, {
      status: "done",
      executionState: completedState,
      factoryManagedTransition: authorizeFactoryManagedTransition(7, finalDecisionId),
    })).resolves.toMatchObject({
      status: "done",
      executionState: expect.objectContaining({
        status: "completed",
        completedStageIds: completedState.completedStageIds,
      }),
    });
    expect(
      await db.select().from(deliveryEvents).where(eq(deliveryEvents.issueId, laneIssueId)),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "business_acceptance",
        state: "accepted",
        candidateSha,
        environment: "production",
        provider: "cloudflare",
        providerExternalId: "production-deployment-1",
        providerUrl: "https://paperclip.example/deployments/production-deployment-1",
        sourceKind: "paperclip_action",
        authority: "paperclip_verified",
        metadata: expect.objectContaining({
          decisionId: finalDecisionId,
          verifiedDeploymentTarget: {
            environment: "production",
            provider: "cloudflare",
            externalId: "production-deployment-1",
            url: "https://paperclip.example/deployments/production-deployment-1",
          },
        }),
      }),
    ]));
  });
});

describeEmbeddedPostgres("issueService blockers and dependency wake readiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-blockers-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists blocked-by relations and exposes both blockedBy and blocks summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const blockerRelations = await svc.getRelationSummaries(blockerId);
    const blockedRelations = await svc.getRelationSummaries(blockedId);

    expect(blockerRelations.blocks.map((relation) => relation.id)).toEqual([blockedId]);
    expect(blockedRelations.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
  });

  it("allows one initiative to be blocked by another initiative", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const signupsInitiativeId = randomUUID();
    const activeUsersInitiativeId = randomUUID();
    await db.insert(issues).values([
      {
        id: signupsInitiativeId,
        companyId,
        identifier: "GTM-1",
        title: "Close 100 client signups",
        status: "in_progress",
        priority: "high",
        workItemType: "initiative",
      },
      {
        id: activeUsersInitiativeId,
        companyId,
        identifier: "GTM-2",
        title: "Achieve 100 active users",
        status: "blocked",
        priority: "high",
        workItemType: "initiative",
      },
    ]);

    await svc.update(activeUsersInitiativeId, {
      blockedByIssueIds: [signupsInitiativeId],
    });

    const relations = await svc.getRelationSummaries(activeUsersInitiativeId);

    expect(relations.blockedBy).toEqual([
      expect.objectContaining({
        id: signupsInitiativeId,
        identifier: "GTM-1",
        title: "Close 100 client signups",
      }),
    ]);
  });

  it("adds terminal blockers to immediate blocked-by summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    const issueC = randomUUID();
    const issueD = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, identifier: "PAP-1", title: "Issue A", status: "blocked", priority: "medium" },
      { id: issueB, companyId, identifier: "PAP-2", title: "Issue B", status: "blocked", priority: "medium" },
      { id: issueC, companyId, identifier: "PAP-3", title: "Issue C", status: "blocked", priority: "medium" },
      { id: issueD, companyId, identifier: "PAP-4", title: "Issue D", status: "todo", priority: "high" },
    ]);

    await svc.update(issueC, { blockedByIssueIds: [issueD] });
    await svc.update(issueB, { blockedByIssueIds: [issueC] });
    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    const relations = await svc.getRelationSummaries(issueA);

    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]).toMatchObject({
      id: issueB,
      identifier: "PAP-2",
      title: "Issue B",
      terminalBlockers: [
        expect.objectContaining({
          id: issueD,
          identifier: "PAP-4",
          title: "Issue D",
          status: "todo",
          priority: "high",
        }),
      ],
    });
  });

  it("rejects blocking cycles", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, title: "Issue A", status: "todo", priority: "medium" },
      { id: issueB, companyId, title: "Issue B", status: "todo", priority: "medium" },
    ]);

    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    await expect(
      svc.update(issueB, { blockedByIssueIds: [issueA] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("only returns dependents once every blocker is done", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, title: "Blocker A", status: "done", priority: "medium" },
      { id: blockerB, companyId, title: "Blocker B", status: "todo", priority: "medium" },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedIssueId, { blockedByIssueIds: [blockerA, blockerB] });

    expect(await svc.listWakeableBlockedDependents(blockerA)).toEqual([]);

    await svc.update(blockerB, { status: "done" });

    await expect(svc.listWakeableBlockedDependents(blockerA)).resolves.toEqual([
      expect.objectContaining({
        id: blockedIssueId,
        assigneeAgentId,
        blockerIssueIds: expect.arrayContaining([blockerA, blockerB]),
      }),
    ]);
  });

  it("reports dependency readiness for blocked issue chains", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      { id: blockedId, companyId, title: "Blocked", status: "todo", priority: "medium" },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    await svc.update(blockerId, { status: "done" });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
  });

  it("rejects execution when unresolved blockers remain", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      {
        id: blockedId,
        companyId,
        title: "Blocked",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(
      svc.update(blockedId, { status: "in_progress" }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      svc.checkout(blockedId, assigneeAgentId, ["todo", "blocked"], null),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("wakes parents only when all direct children are terminal", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parentId = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: childA,
        companyId,
        parentId,
        title: "Child A",
        status: "done",
        priority: "medium",
      },
      {
        id: childB,
        companyId,
        parentId,
        title: "Child B",
        status: "blocked",
        priority: "medium",
      },
    ]);

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();

    await svc.update(childB, { status: "cancelled" });

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toMatchObject({
      id: parentId,
      assigneeAgentId,
      childIssueIds: [childA, childB],
      childIssueSummaries: [
        expect.objectContaining({ id: childA, title: "Child A", status: "done" }),
        expect.objectContaining({ id: childB, title: "Child B", status: "cancelled" }),
      ],
      childIssueSummaryTruncated: false,
    });
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  it("syncs reused execution workspace config when issue workspace settings are updated", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      metadata: {
        config: {
          environmentId: "env-old",
          provisionCommand: "bash ./scripts/provision-old.sh",
          teardownCommand: "bash ./scripts/teardown-old.sh",
          workspaceRuntime: { profile: "old" },
        },
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Recovery issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: "env-old",
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "bash ./scripts/provision-old.sh",
          teardownCommand: "bash ./scripts/teardown-old.sh",
        },
        workspaceRuntime: { profile: "old" },
      },
    });

    await svc.update(issueId, {
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: "env-new",
        workspaceStrategy: {
          type: "cloud_sandbox",
          provisionCommand: "bash ./scripts/provision-new.sh",
          teardownCommand: "bash ./scripts/teardown-new.sh",
        },
        workspaceRuntime: { profile: "new" },
      },
    });

    const workspace = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);

    expect(workspace?.metadata).toEqual({
      config: {
        environmentId: "env-new",
        provisionCommand: "bash ./scripts/provision-new.sh",
        teardownCommand: "bash ./scripts/teardown-new.sh",
        cleanupCommand: null,
        workspaceRuntime: { profile: "new" },
        desiredState: null,
        serviceStates: null,
      },
    });
  });
});

describeEmbeddedPostgres("issueService.findMentionedProjectIds", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-mentioned-projects-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("can skip comment-body scans for bounded issue detail reads", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const titleProjectId = randomUUID();
    const commentProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values([
      {
        id: titleProjectId,
        companyId,
        name: "Title project",
        status: "in_progress",
      },
      {
        id: commentProjectId,
        companyId,
        name: "Comment project",
        status: "in_progress",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Link [Title](${buildProjectMentionHref(titleProjectId)})`,
      description: null,
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: `Comment link [Comment](${buildProjectMentionHref(commentProjectId)})`,
    });

    expect(await svc.findMentionedProjectIds(issueId, { includeCommentBodies: false })).toEqual([titleProjectId]);
    expect(await svc.findMentionedProjectIds(issueId)).toEqual([
      titleProjectId,
      commentProjectId,
    ]);
  });
});

describeEmbeddedPostgres("issueService.clearExecutionRunIfTerminal", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-execution-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithRun(status: string | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = status ? randomUUID() : null;

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
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (runId) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status,
        invocationSource: "manual",
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: runId ? "codexcoder" : null,
      executionLockedAt: runId ? new Date() : null,
    });

    return { issueId, runId };
  }

  it("clears execution locks owned by terminal runs", async () => {
    const { issueId } = await seedIssueWithRun("failed");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(true);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("does not clear execution locks owned by live runs", async () => {
    const { issueId, runId } = await seedIssueWithRun("running");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(runId);
    expect(row?.executionAgentNameKey).toBe("codexcoder");
    expect(row?.executionLockedAt).toBeInstanceOf(Date);
  });

  it("does not update issues without an execution lock", async () => {
    const { issueId } = await seedIssueWithRun(null);

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({ executionRunId: issues.executionRunId, executionLockedAt: issues.executionLockedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });
  });
});
