import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  heartbeatRuns,
  agentWakeupRequests,
  companies,
  createDb,
  deliveryEvents,
  deliveryFindings,
  deliveryPolicies,
  deliveryQueueEntries,
  deliveryReceipts,
  deliveryReconciliations,
  deliveryRepairAttempts,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  projects,
  toolApplications,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { deliveryEventService } from "../services/delivery/events.js";
import { createDeliveryDoneGate } from "../services/delivery/done-gate.js";
import { deliveryPolicyService } from "../services/delivery/policy.js";
import { deliveryQueueService } from "../services/delivery/queue.js";
import { deliveryReconciliationService } from "../services/delivery/reconciliation.js";
import { deliveryUnitService, type DeliveryActor, type DeliveryWakeEnqueue } from "../services/delivery/units.js";
import { deliveryService } from "../services/delivery/service.js";
import { greptileReviewService } from "../services/delivery/greptile.js";
import { getNativeDeliveryWait } from "../services/delivery/native-delivery-wait.js";
import { recordObservedFindings } from "../services/delivery/findings.js";
import { deliveryMergeExecutor } from "../services/delivery/merge-executor.js";
import { deliveryReconciler } from "../services/delivery/reconciler.js";
import type { GitHubDeliveryClient } from "../services/delivery/github-client.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

function githubStub(overrides: Partial<GitHubDeliveryClient> = {}): GitHubDeliveryClient {
  const failure = { ok: false, status: null, errorCode: "github_unreachable", message: "stub", retryAfterSeconds: null } as const;
  return {
    resolveToken: async () => failure,
    getRepository: async () => failure,
    getPullRequest: async () => failure,
    getChecks: async () => failure,
    getReviews: async () => failure,
    getReviewComments: async () => failure,
    mergePullRequest: async () => failure,
    enqueuePullRequest: async () => failure,
    compareCommits: async () => failure,
    findOpenPullRequest: async () => failure,
    ...overrides,
  } as GitHubDeliveryClient;
}

/** Authoritative GitHub review comments for the same pull request. */
function reviewComments(rows: Array<{ id: string; commitSha: string }>) {
  return {
    ok: true,
    value: rows.map((row) => ({
      id: row.id,
      login: "greptile-apps",
      commitSha: row.commitSha,
      path: "dispatch.ts",
      line: 12,
      body: "Duplicate dispatch",
      url: null,
      createdAt: "2026-09-01T00:00:00Z",
    })),
  } as const;
}

/** Governed Greptile MCP payloads in the provider's real nested shape. */
function greptileToolGateway(input: {
  review?: Record<string, unknown>;
  comments?: Array<Record<string, unknown>>;
  commentsFailure?: boolean;
}) {
  return {
    readConnectedTool: async ({ toolName }: { toolName: string }) => {
      if (toolName === "get_merge_request") {
        return {
          ok: true,
          result: {
            content: JSON.stringify({
              mergeRequest: {
                codeReviews: [input.review ?? { status: "COMPLETED" }],
              },
            }),
          },
        };
      }
      if (input.commentsFailure) {
        return { ok: false, errorCode: "tool_call_failed", message: "comments unreadable" };
      }
      return { ok: true, result: { content: JSON.stringify({ comments: input.comments ?? [] }) } };
    },
  };
}

function openPr(headSha: string) {
  return {
    ok: true,
    value: {
      number: 7,
      url: "https://github.com/acme/widget/pull/7",
      nodeId: "node-1",
      authorLogin: "author",
      state: "open",
      draft: false,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: "delivery/x",
      headSha,
      baseRef: "main",
      baseSha: "c".repeat(40),
      mergeable: true,
      mergeableState: "clean",
      title: "x",
      updatedAt: "2026-09-01T00:00:00Z",
    },
  } as const;
}

describeEmbeddedPostgres("delivery lifecycle boundary regressions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-boundary-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(deliveryEvents);
    await db.delete(deliveryRepairAttempts);
    await db.delete(deliveryFindings);
    await db.delete(deliveryReceipts);
    await db.delete(deliveryReconciliations);
    await db.delete(deliveryQueueEntries);
    await db.delete(deliveryUnitIssues);
    await db.delete(deliveryUnits);
    await db.delete(deliveryRepositories);
    await db.delete(deliveryPolicies);
    await db.delete(activityLog);
    await db.delete(projectWorkspaces);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedProject(companyId: string, repoUrl: string | null = null): Promise<string> {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Widget", status: "in_progress" });
    if (repoUrl) {
      await db.insert(projectWorkspaces).values({
        companyId,
        projectId,
        name: "primary",
        repoUrl,
        isPrimary: true,
      });
    }
    return projectId;
  }

  async function seedIssue(companyId: string, projectId: string, status = "in_review") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Widget work",
      status,
      priority: "medium",
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return issue!;
  }

  async function seedRepository(companyId: string) {
    const [repository] = await db.insert(deliveryRepositories).values({
      companyId,
      owner: "acme",
      name: "widget",
      githubRepositoryId: "123",
      defaultBranch: "main",
    }).returning();
    return repository!;
  }

  function services(github: GitHubDeliveryClient, requestOwnerWake?: DeliveryWakeEnqueue) {
    const events = deliveryEventService(db as unknown as Db);
    const policy = deliveryPolicyService(db as unknown as Db, { github });
    const queue = deliveryQueueService(db as unknown as Db);
    const units = deliveryUnitService(db as unknown as Db, { policy, queue, events, github, requestOwnerWake });
    return { events, policy, queue, units };
  }

  const userActor: DeliveryActor = { type: "user", id: "user-1", userId: "user-1" };

  it("permits merge-only authority for verified deployment separation but blocks an unknown default-branch effect", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main",
      enabled: true, autoDeployDisposition: "no_auto_deploy",
      requireIndependentApproval: false, requireGreptile: false,
      authorization: { approvedByUserId: "user-1", approvedAt: new Date().toISOString(), statement: "Merge only; automatic deployment triggers verified absent. No deployment authorized.", scope: "project" },
    });
    const { policy } = services(githubStub());
    const input = {
      companyId, projectId, targetBranch: "main", requireGreptile: false,
      evidence: { headSha: HEAD, checks: [], reviewStatus: "approved", reviewHeadSha: HEAD, approvals: [], prAuthorLogin: "author", blockingFindings: 0 },
    };
    expect(await policy.evaluateUnit(input)).toMatchObject({ allowed: true });
    await db.update(deliveryPolicies).set({ autoDeployDisposition: "none" }).where(eq(deliveryPolicies.projectId, projectId));
    expect(await policy.evaluateUnit(input)).toMatchObject({ allowed: false, blocker: { reasonCode: "deployment_authority_missing" } });
  });

  it("serializes concurrent leases for the same repository and branch", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const { queue } = services(githubStub());
    const first = await seedIssue(companyId, projectId);
    const second = await seedIssue(companyId, projectId);
    const unitA = await db.insert(deliveryUnits).values({
      companyId, repositoryId: repository.id, primaryIssueId: first.id,
      targetBranch: "main", sourceBranch: "delivery/a", headSha: HEAD,
    }).returning().then((rows) => rows[0]!);
    const unitB = await db.insert(deliveryUnits).values({
      companyId, repositoryId: repository.id, primaryIssueId: second.id,
      targetBranch: "main", sourceBranch: "delivery/b", headSha: OTHER_HEAD,
    }).returning().then((rows) => rows[0]!);
    await queue.enqueue({ companyId, repositoryId: repository.id, targetBranch: "main", unitId: unitA.id, priority: "high" });
    await queue.enqueue({ companyId, repositoryId: repository.id, targetBranch: "main", unitId: unitB.id, priority: "medium" });

    const leases = await Promise.all([
      queue.leaseNext({ companyId, repositoryId: repository.id, targetBranch: "main", leaseOwner: "sweep-1" }),
      queue.leaseNext({ companyId, repositoryId: repository.id, targetBranch: "main", leaseOwner: "sweep-2" }),
    ]);
    expect(leases.filter((entry) => entry !== null)).toHaveLength(1);
    const leased = leases.find((entry) => entry !== null)!;
    expect(leased.unitId).toBe(unitA.id);
    expect(await queue.leaseNext({ companyId, repositoryId: repository.id, targetBranch: "main", leaseOwner: "sweep-3" })).toBeNull();

    await queue.releaseLease({ companyId, unitId: unitA.id, leaseOwner: leased.leaseOwner!, leaseEpoch: leased.leaseEpoch });
    const next = await queue.leaseNext({ companyId, repositoryId: repository.id, targetBranch: "main", leaseOwner: "sweep-2" });
    expect(next?.unitId).toBe(unitA.id);
  });

  it.each(["serialized", "native_merge_queue"] as const)("refuses %s publication after its lease is revoked during review", async (mergeQueueMode) => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main",
      enabled: true, mergeQueueMode, autoDeployDisposition: "authorized",
      authorization: {
        approvedByUserId: "user-1", approvedAt: new Date().toISOString(),
        statement: "Isolated merge fencing regression", scope: "project",
      },
    });
    const [unit] = await db.insert(deliveryUnits).values({
      companyId, projectId, repositoryId: repository.id, primaryIssueId: issue.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD,
      acceptedHeadSha: HEAD, prNumber: 7, status: "ready_to_merge",
    }).returning();
    const github = githubStub({
      getPullRequest: async () => openPr(HEAD),
      getChecks: async () => ({ ok: true, value: [] }),
      getReviews: async () => {
        await queue.releaseLease({
          companyId, unitId: unit!.id, leaseOwner: "sweep", leaseEpoch: leased!.leaseEpoch,
        });
        return {
          ok: true,
          value: {
            status: "approved", headSha: HEAD, approvedHeadSha: HEAD,
            approvals: [{ login: "independent-reviewer", commitSha: HEAD }],
            blockingFindings: 0, reviews: [],
          },
        };
      },
    });
    const merge = vi.spyOn(github, "mergePullRequest");
    const enqueue = vi.spyOn(github, "enqueuePullRequest");
    const { queue, ...dependencies } = services(github);
    const greptile = greptileReviewService(db, {
      github,
      toolGateway: { readConnectedTool: async () => { throw new Error("Unexpected Greptile read"); } },
    });
    const setIssueStatus = async () => { throw new Error("Lost lease must not mutate issue status"); };
    const deps = { ...dependencies, queue, github, greptile, setIssueStatus };
    const reconciler = deliveryReconciler(db, deps);
    const executor = deliveryMergeExecutor(db, { ...deps, reconciler });
    await queue.enqueue({
      companyId, repositoryId: repository.id, targetBranch: "main", unitId: unit!.id, priority: "medium",
    });
    const leased = await queue.leaseNext({
      companyId, repositoryId: repository.id, targetBranch: "main", leaseOwner: "sweep",
    });
    const outcome = await executor.attemptMerge({
      companyId, unitId: unit!.id, lease: { leaseOwner: "sweep", leaseEpoch: leased!.leaseEpoch },
    });
    expect(merge).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(outcome.reasonCode).toBe("lease_lost");
    expect((await queue.getEntry(companyId, unit!.id))?.status).toBe("queued");
  });

  it("blocks Done through the real issue mutation when no policy exists on a GitHub project", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const issue = await seedIssue(companyId, projectId);
    const svc = issueService(db as unknown as Db);

    await expect(svc.update(issue.id, { status: "done" }, db)).rejects.toMatchObject({
      details: expect.objectContaining({ reasonCode: "delivery_candidate_required" }),
    });

    const { units } = services(githubStub());
    expect(await units.buildSummary(companyId, issue.id)).toMatchObject({
      codeDelivery: true,
      blocker: { reasonCode: "policy_missing" },
    });
    await units.recordDisposition({
      companyId,
      issue,
      actor: userActor,
      kind: "non_code",
      reasonCode: "genuine_non_code",
      message: "Operator-confirmed Docs-only change",
    });
    const updated = await svc.update(issue.id, { status: "done" }, db);
    expect(updated?.status).toBe("done");
  });

  it("does not let an operator non-code disposition hide unfinished child delivery", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const parent = await seedIssue(companyId, projectId);
    const child = await seedIssue(companyId, projectId);
    await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, child.id));
    const { units } = services(githubStub());
    const svc = issueService(db as unknown as Db);
    await units.recordDisposition({
      companyId, issue: parent, actor: userActor, kind: "non_code",
      reasonCode: "coordination_only", message: "Parent coordinates the child delivery",
    });
    await expect(svc.update(parent.id, { status: "done" }, db)).rejects.toMatchObject({
      details: expect.objectContaining({ reasonCode: "delivery_children_incomplete" }),
    });
    await units.recordDisposition({
      companyId, issue: child, actor: userActor, kind: "non_code",
      reasonCode: "no_code_change", message: "Child investigation completed without code changes",
    });
    await svc.update(child.id, { status: "done" }, db);
    expect((await svc.update(parent.id, { status: "done" }, db))?.status).toBe("done");
  });

  it("fails submit closed when the pull request read fails or the head mismatches", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main", enabled: true,
    });
    const { units } = services(githubStub());
    const issue = await seedIssue(companyId, projectId);
    const actor = userActor;

    await expect(units.registerCandidate({
      companyId, issue, actor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    })).rejects.toMatchObject({ details: expect.objectContaining({ reasonCode: "provider_unknown" }) });
    expect(await db.select().from(deliveryUnits)).toEqual([]);

    const { units: mismatchUnits } = services(githubStub({
      findOpenPullRequest: async () => openPr(OTHER_HEAD),
    }));
    await expect(mismatchUnits.registerCandidate({
      companyId, issue, actor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    })).rejects.toMatchObject({ details: expect.objectContaining({ reasonCode: "head_stale" }) });
    expect(await db.select().from(deliveryUnits)).toEqual([]);
  });

  it("forbids an agent from covering issues assigned to someone else", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main", enabled: true,
    });
    const { units } = services(githubStub({ findOpenPullRequest: async () => openPr(HEAD) }));
    const issue = await seedIssue(companyId, projectId);
    const covered = await seedIssue(companyId, projectId);

    await expect(units.registerCandidate({
      companyId, issue,
      actor: { type: "agent", id: "agent-1", agentId: "agent-1" },
      headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
      coveredIssueIds: [covered.id],
    })).rejects.toMatchObject({ status: 403 });
  });

  it("treats a failed Greptile comments read as a failed read, not a partial success", async () => {
    const github = githubStub({ getReviewComments: async () => reviewComments([]) });
    const greptile = greptileReviewService({} as unknown as Db, {
      github,
      toolGateway: greptileToolGateway({ commentsFailure: true }),
    });
    const result = await greptile.read({
      companyId: randomUUID(),
      connectionId: randomUUID(),
      repositoryName: "widget",
      defaultBranch: "main",
      prNumber: 7,
      correlation: { host: "github.com", connectionId: null, owner: "acme", repo: "widget" },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "tool_call_failed" });
  });

  it("moves covered issues into review on submit without reopening blocked or terminal ones", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main", enabled: true,
    });
    const { units } = services(githubStub({ findOpenPullRequest: async () => openPr(HEAD) }));
    const primary = await seedIssue(companyId, projectId, "in_progress");
    const covered = await seedIssue(companyId, projectId, "todo");
    const blockedCovered = await seedIssue(companyId, projectId, "blocked");
    const doneCovered = await seedIssue(companyId, projectId, "done");

    await units.registerCandidate({
      companyId, issue: primary, actor: userActor,
      headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
      coveredIssueIds: [covered.id, blockedCovered.id, doneCovered.id],
    });

    const statusOf = async (issueId: string) =>
      (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status;
    expect(await statusOf(primary.id)).toBe("in_review");
    expect(await statusOf(covered.id)).toBe("in_review");
    // An explicit operator/board state is never overwritten by submission.
    expect(await statusOf(blockedCovered.id)).toBe("blocked");
    expect(await statusOf(doneCovered.id)).toBe("done");
  });

  it("voids standing authorization when the target branch changes", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const { policy } = services(githubStub());
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main", enabled: true,
      authorization: { approvedByUserId: "user-1", approvedAt: "2026-09-01T00:00:00Z", statement: "go", scope: "project" },
    });

    const updated = await policy.upsertPolicy({ companyId, projectId, actorUserId: null, patch: { targetBranch: "release" } });
    expect(updated.authorization).toBeNull();
    expect(updated.version).toBe(2);
  });

  it("stores an unverifiable operator code_verified claim as code_unverified", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId, "done");
    const [unit] = await db.insert(deliveryUnits).values({
      companyId, repositoryId: repository.id, primaryIssueId: issue.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD,
    }).returning();
    await db.insert(deliveryUnitIssues).values({ companyId, unitId: unit!.id, issueId: issue.id, role: "primary" });
    const reconciliation = deliveryReconciliationService(db as unknown as Db, {
      github: githubStub({
        compareCommits: async () => ({ ok: true, value: { status: "behind", aheadBy: 0, behindBy: 3, included: false } }),
      }),
    });

    const item = await reconciliation.record({
      companyId,
      actor: userActor,
      write: {
        idempotencyKey: randomUUID(),
        issueId: issue.id,
        classification: "code_verified",
        provenance: { repository: "acme/widget", targetBranch: "main", mergedSha: HEAD },
      },
    });
    expect(item.classification).toBe("code_unverified");
    expect(item.provenance).toBeNull();
  });

  it("imports remotely included historical work without republishing and shares its receipt", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main",
    });
    const first = await seedIssue(companyId, projectId, "done");
    const covered = await seedIssue(companyId, projectId, "done");
    const github = githubStub({
      compareCommits: async () => ({ ok: true, value: { status: "identical", aheadBy: 0, behindBy: 0, included: true } }),
    });
    const reconciliation = deliveryReconciliationService(db as unknown as Db, { github });
    for (const issue of [first, covered]) {
      const result = await reconciliation.record({
        companyId, actor: userActor,
        write: {
          idempotencyKey: randomUUID(), issueId: issue.id, classification: "code_verified",
          provenance: { repository: "acme/widget", targetBranch: "main", mergedSha: HEAD, headSha: HEAD },
        },
      });
      expect(result.classification).toBe("code_verified");
    }
    const { units } = services(github);
    const summary = await units.buildSummary(companyId, first.id);
    expect(summary).toMatchObject({ phase: "done", mergedSha: HEAD });
    expect((await units.buildSummary(companyId, covered.id)).unitId).toBe(summary.unitId);
    const inventory = await reconciliation.inventory({ companyId, projectId });
    expect(inventory.items.map((item) => item.classification)).toEqual(["code_verified", "code_verified"]);
    expect(inventory.items.every((item) => item.provenance?.acceptedHeadSha === HEAD)).toBe(true);
    const gate = createDeliveryDoneGate(db as unknown as Db);
    expect(await gate.evaluateDone({ companyId, issue: first })).toMatchObject({ allowed: true });
  });

  it("records remotely proven historical rewrites without inventing the merge method", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId, "done");
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main", mergeMethod: "merge",
    });
    const github = githubStub({
      getPullRequest: async () => ({
        ok: true,
        value: { ...openPr(HEAD).value, state: "closed", merged: true, mergeCommitSha: OTHER_HEAD },
      }),
      compareCommits: async (_company, _connection, _host, _owner, _name, revision) => ({
        ok: true,
        value: { status: revision === OTHER_HEAD ? "ahead" : "diverged", aheadBy: 1, behindBy: revision === OTHER_HEAD ? 0 : 1, included: revision === OTHER_HEAD },
      }),
    });
    const item = await deliveryReconciliationService(db as unknown as Db, { github }).record({
      companyId, actor: userActor,
      write: {
        idempotencyKey: randomUUID(), issueId: issue.id, classification: "code_verified",
        provenance: { repository: "acme/widget", targetBranch: "main", prNumber: 7, mergedSha: OTHER_HEAD, headSha: HEAD },
      },
    });
    expect(item).toMatchObject({
      classification: "code_verified",
      provenance: { mergeMethod: "unknown", squashOrRebase: true, acceptedHeadSha: HEAD, mergedSha: OTHER_HEAD },
    });
    expect(await createDeliveryDoneGate(db as unknown as Db).evaluateDone({ companyId, issue })).toMatchObject({ allowed: true });
  });

  it("defers a historical PR already tracked by a live delivery unit", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId, "done");
    const active = await seedIssue(companyId, projectId);
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main",
    });
    await db.insert(deliveryUnits).values({
      companyId, projectId, repositoryId: repository.id, primaryIssueId: active.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD, prNumber: 7,
    });
    const github = githubStub({
      getPullRequest: async () => ({
        ok: true,
        value: { ...openPr(HEAD).value, state: "closed", merged: true, mergeCommitSha: HEAD },
      }),
      compareCommits: async () => ({ ok: true, value: { status: "identical", aheadBy: 0, behindBy: 0, included: true } }),
    });
    const item = await deliveryReconciliationService(db as unknown as Db, { github }).record({
      companyId, actor: userActor,
      write: {
        idempotencyKey: randomUUID(), issueId: issue.id, classification: "code_verified",
        provenance: { repository: "acme/widget", targetBranch: "main", prNumber: 7, mergedSha: HEAD, headSha: HEAD },
      },
    });
    expect(item).toMatchObject({ classification: "code_unverified", provenance: null });
    expect(await createDeliveryDoneGate(db as unknown as Db).evaluateDone({ companyId, issue })).toMatchObject({ allowed: false });
  });

  it("rejects a replay key for another issue before importing its receipt", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const first = await seedIssue(companyId, projectId, "done");
    const second = await seedIssue(companyId, projectId, "done");
    await db.insert(deliveryPolicies).values({ companyId, projectId, repositoryId: repository.id, targetBranch: "main" });
    const reconciliation = deliveryReconciliationService(db as unknown as Db, {
      github: githubStub({
        compareCommits: async () => ({ ok: true, value: { status: "identical", aheadBy: 0, behindBy: 0, included: true } }),
      }),
    });
    const idempotencyKey = randomUUID();
    await reconciliation.record({
      companyId, actor: userActor,
      write: { issueId: first.id, idempotencyKey, classification: "code_unverified" },
    });
    await expect(reconciliation.record({
      companyId, actor: userActor,
      write: {
        issueId: second.id, idempotencyKey, classification: "code_verified",
        provenance: { repository: "acme/widget", targetBranch: "main", mergedSha: HEAD, headSha: HEAD },
      },
    })).rejects.toMatchObject({ status: 409 });
    expect(await createDeliveryDoneGate(db as unknown as Db).evaluateDone({ companyId, issue: second })).toMatchObject({ allowed: false });
  });

  it("does not certify an unrelated historical head using an included target revision", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId, "done");
    await db.insert(deliveryPolicies).values({
      companyId, projectId, repositoryId: repository.id, targetBranch: "main",
    });
    const github = githubStub({
      compareCommits: async () => ({ ok: true, value: { status: "identical", aheadBy: 0, behindBy: 0, included: true } }),
    });
    const reconciliation = deliveryReconciliationService(db as unknown as Db, { github });
    const item = await reconciliation.record({
      companyId, actor: userActor,
      write: {
        idempotencyKey: randomUUID(), issueId: issue.id, classification: "code_verified",
        provenance: { repository: "acme/widget", targetBranch: "main", mergedSha: HEAD, headSha: OTHER_HEAD },
      },
    });
    expect(item).toMatchObject({ classification: "code_unverified", provenance: null });
    expect(await createDeliveryDoneGate(db as unknown as Db).evaluateDone({ companyId, issue })).toMatchObject({ allowed: false });
  });

  it("refuses pause on merged units and disposition from agents", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const { units } = services(githubStub());
    const issue = await seedIssue(companyId, projectId);
    const [merged] = await db.insert(deliveryUnits).values({
      companyId, repositoryId: repository.id, primaryIssueId: issue.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD, status: "merged",
    }).returning();

    await expect(units.pauseUnit({ companyId, unitId: merged!.id, actor: userActor })).rejects.toMatchObject({ status: 409 });
    await expect(units.recordDisposition({
      companyId, issue,
      actor: { type: "agent", id: "agent-1", agentId: "agent-1" },
      kind: "non_code", reasonCode: "x", message: "self-serve",
    })).rejects.toMatchObject({ status: 403 });
  });

  it("retries without resetting the merge-attempt bound", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
    const [unit] = await db.insert(deliveryUnits).values({
      companyId, repositoryId: repository.id, primaryIssueId: issue.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD,
      status: "cancelled", mergeAttemptCount: 3,
    }).returning();
    await db.insert(deliveryUnitIssues).values({ companyId, unitId: unit!.id, issueId: issue.id, role: "primary" });
    const delivery = deliveryService(db as unknown as Db, {
      toolGateway: { readConnectedTool: vi.fn() },
    });

    await delivery.retry({ companyId, issueId: issue.id, actor: userActor });
    const [after] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unit!.id));
    expect(after?.mergeAttemptCount).toBe(3);

    await db.update(deliveryUnits).set({ mergeAttemptCount: 5 }).where(eq(deliveryUnits.id, unit!.id));
    await expect(delivery.retry({ companyId, issueId: issue.id, actor: userActor })).rejects.toMatchObject({
      details: expect.objectContaining({ reasonCode: "repair_attempts_exhausted" }),
    });
  });

  /**
   * Governed pipeline harness: one repository, one required-Greptile policy, one
   * registered candidate, and a Greptile MCP read whose payload the test owns.
   */
  async function governedPipeline(
    input: { reviewState?: "COMPLETED" | "IN_PROGRESS"; revision?: string; failRead?: boolean; canDispatch?: () => boolean } = {},
  ) {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
    const [owner] = await db.insert(agents).values({
      companyId, name: "Implementation Agent", role: "engineer", status: "idle",
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId, name: "Greptile", type: "mcp_http",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "Greptile", uid: randomUUID(),
      transport: "mcp_remote", status: "active", enabled: true,
    }).returning();
    await db.insert(deliveryPolicies).values({
      companyId,
      projectId,
      repositoryId: repository.id,
      targetBranch: "main",
      enabled: true,
      requireGreptile: true,
      greptileConnectionId: connection!.id,
      autoDeployDisposition: "authorized",
      authorization: {
        approvedByUserId: "user-1",
        approvedAt: "2026-09-01T00:00:00Z",
        statement: "Merge authorized; trigger separation verified",
        scope: "project",
      },
    });
    const [unit] = await db.insert(deliveryUnits).values({
      companyId, projectId, repositoryId: repository.id, primaryIssueId: issue.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD, prNumber: 7, status: "submitted", ownerAgentId: owner!.id,
    }).returning();
    await db.insert(deliveryUnitIssues).values({ companyId, unitId: unit!.id, issueId: issue.id, role: "primary" });

    const provider = { addressed: false, findingId: "scm-1", body: "P1: duplicate dispatch" };
    const merges: string[] = [];
    const statusWrites: string[] = [];
    const github = githubStub({
      getPullRequest: async () => openPr(HEAD),
      findOpenPullRequest: async () => openPr(HEAD),
      getChecks: async () => ({ ok: true, value: [] }),
      getReviews: async () => ({
        ok: true,
        value: {
          status: "commented", headSha: HEAD, approvedHeadSha: HEAD,
          approvals: [{ login: "independent-reviewer", commitSha: HEAD }],
          blockingFindings: 0, reviews: [],
        },
      }),
      getReviewComments: async () => reviewComments([{ id: provider.findingId, commitSha: input.revision ?? HEAD }]),
      mergePullRequest: async (_company, _connection, _host, _owner, _repo, _number, mergeInput) => {
        merges.push(mergeInput.sha);
        return { ok: true, value: { merged: true, sha: mergeInput.sha, message: "merged" } };
      },
      compareCommits: async () => ({ ok: true, value: { status: "identical", aheadBy: 0, behindBy: 0, included: true } }),
    });
    const greptile = greptileReviewService(db, {
      github,
      toolGateway: greptileToolGateway({
        review: { status: input.reviewState ?? "COMPLETED" },
        commentsFailure: input.failRead,
        comments: [{
          id: "internal-1",
          get commentId() { return provider.findingId; },
          // The real payload carries no severity field: the priority is only in
          // the comment body, and `addressed` is the vendor's own flag.
          get body() { return provider.body; },
          filePath: "dispatch.ts",
          lineStart: 30,
          lineEnd: 36,
          isGreptileComment: true,
          get addressed() {
            return provider.addressed;
          },
        }],
      }),
    });
    const { queue, ...dependencies } = services(github, async (agentId, options) => {
      if (input.canDispatch && !input.canDispatch()) return null;
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId, invocationSource: "automation", triggerDetail: "system",
        // Heartbeat builds the run context from the separate `contextSnapshot`
        // option; the harness mirrors that so controller-owned context (for
        // example `deliveryRepair`) is carried exactly as the real dispatcher
        // carries it.
        status: "queued",
        contextSnapshot: { ...(options.payload ?? {}), ...(options.contextSnapshot ?? {}) },
      }).returning();
      return run;
    });
    const setIssueStatus = async ({ status }: { status: string }) => { statusWrites.push(status); };
    const deps = { ...dependencies, queue, github, greptile, setIssueStatus };
    const reconciler = deliveryReconciler(db, deps);
    const executor = deliveryMergeExecutor(db, { ...deps, reconciler });
    await queue.enqueue({
      companyId, repositoryId: repository.id, targetBranch: "main", unitId: unit!.id, priority: "medium",
    });
    return { companyId, projectId, repository, issue, unit: unit!, provider, merges, statusWrites, github, greptile, queue, reconciler, executor, units: dependencies.units };
  }

  it("delivers unchanged repair evidence after a suppressed dispatch recovers", async () => {
    let available = false;
    const pipeline = await governedPipeline({ canDispatch: () => available });
    const { companyId, unit } = pipeline;
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toEqual([]);
    available = true;
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .toMatchObject([{ agentId: unit.ownerAgentId, contextSnapshot: { issueId: pipeline.issue.id, reasonCode: "review_blocking_findings" } }]);
    expect(await repairAttempts(companyId, unit.id)).toMatchObject([{ status: "requested" }, { status: "dispatched" }]);
  });

  it("exposes exhausted repairs instead of claiming a nonexistent owner continuation", async () => {
    const pipeline = await governedPipeline();
    const { companyId, unit } = pipeline;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      pipeline.provider.body = `P1: unresolved defect ${attempt}`;
      await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    }
    expect(await pipeline.units.getUnit(companyId, unit.id))
      .toMatchObject({ status: "blocked", blocker: { reasonCode: "repair_attempts_exhausted" } });
    expect(await getNativeDeliveryWait(db, companyId, pipeline.issue.id)).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await pipeline.units.getUnit(companyId, unit.id))
      .toMatchObject({ blocker: { reasonCode: "repair_attempts_exhausted" } });
    expect((await repairAttempts(companyId, unit.id)).filter((attempt) => attempt.status === "exhausted")).toHaveLength(1);
    pipeline.provider.addressed = true;
    expect(await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" }))
      .toMatchObject({ status: "ready_to_merge" });
  });

  it("wakes on changed blocking findings but ignores unrelated check churn", async () => {
    const pipeline = await governedPipeline();
    const { companyId, unit } = pipeline;
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    pipeline.github.getChecks = async () => ({ ok: true, value: [{ name: "optional", status: "failure", url: null }] });
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    pipeline.provider.findingId = "scm-new";
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
    pipeline.provider.body = "P1: revised actionable explanation";
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
  });

  it.each([{ enabled: false, paused: false }, { enabled: true, paused: true }])(
    "preserves implementation status when policy cannot own review: %j", async (policyState) => {
      const pipeline = await governedPipeline();
      const { companyId, projectId, issue } = pipeline;
      await db.update(deliveryPolicies).set(policyState).where(eq(deliveryPolicies.projectId, projectId));
      const [implementation] = await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issue.id)).returning();
      await pipeline.units.registerCandidate({
        companyId, issue: implementation!, actor: userActor,
        headSha: HEAD, sourceBranch: "delivery/x", artifactReady: true,
      });
      const [preserved] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(preserved?.status).toBe("in_progress");
    },
  );

  it("queues an owner repair when native merge-queue admission conflicts", async () => {
    const pipeline = await governedPipeline();
    const { companyId, projectId, unit } = pipeline;
    pipeline.provider.addressed = true;
    await db.update(deliveryPolicies).set({ mergeQueueMode: "native_merge_queue" }).where(eq(deliveryPolicies.projectId, projectId));
    pipeline.github.enqueuePullRequest = async () => ({ ok: false, status: 409, errorCode: "conflict", message: "Conflict" });
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    const lease = await pipeline.queue.leaseNext({ companyId, repositoryId: pipeline.repository.id, targetBranch: "main", leaseOwner: "queue-test" });
    expect(await pipeline.executor.attemptMerge({
      companyId, unitId: unit.id, lease: { leaseOwner: "queue-test", leaseEpoch: lease!.leaseEpoch },
    })).toMatchObject({ blocked: true, reasonCode: "conflict" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .toMatchObject([{ contextSnapshot: { issueId: pipeline.issue.id, reasonCode: "conflict" } }]);
    expect(pipeline.merges).toEqual([]);
  });

  it("honors an explicit delivery retry while ordinary reconciliation stays deduplicated", async () => {
    const pipeline = await governedPipeline();
    const { companyId, unit, issue } = pipeline;
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    await pipeline.reconciler.reconcileIssue({ companyId, issueId: issue.id });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    const svc = deliveryService(db, { toolGateway: greptileToolGateway({}) });
    vi.spyOn(svc.services.reconciler, "reconcileIssue").mockImplementation(pipeline.reconciler.reconcileIssue);
    await svc.retry({ companyId, issueId: issue.id, actor: userActor });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
  });

  async function repairAttempts(companyId: string, unitId: string) {
    return await db
      .select()
      .from(deliveryRepairAttempts)
      .where(and(eq(deliveryRepairAttempts.companyId, companyId), eq(deliveryRepairAttempts.unitId, unitId)))
      .orderBy(deliveryRepairAttempts.attempt);
  }

  it("re-dispatches a repair whose owner execution vanished while preserving dedupe for live and completed runs", async () => {
    const pipeline = await governedPipeline();
    const { companyId, unit } = pipeline;
    const runs = async () => await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));

    // First actionable evidence dispatches the owner with the controller's own
    // repair context (unit, generation, head, reason, attempt).
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    const first = await runs();
    expect(first).toHaveLength(1);
    expect(first[0]?.contextSnapshot).toMatchObject({
      deliveryRepair: {
        unitId: unit.id,
        candidateGeneration: 1,
        headSha: HEAD,
        reasonCode: "review_blocking_findings",
        attempt: 1,
      },
    });

    // A live execution handles the signal: repeated sweeps spend no attempt.
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await runs()).toHaveLength(1);
    expect(await repairAttempts(companyId, unit.id)).toHaveLength(1);

    // Process loss: the run ends without completing and has no live retry, so
    // the unchanged signal is unhandled again and dispatches exactly once more.
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, first[0]!.id));
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    const afterLoss = await runs();
    expect(afterLoss).toHaveLength(2);
    const reDispatched = afterLoss.find((run) => run.status === "queued");
    expect(reDispatched).toMatchObject({
      agentId: unit.ownerAgentId,
      contextSnapshot: { deliveryRepair: { unitId: unit.id, reasonCode: "review_blocking_findings", attempt: 2 } },
    });
    expect(await repairAttempts(companyId, unit.id)).toMatchObject([
      { attempt: 1, status: "dispatched", signal: expect.stringContaining("v1:") },
      { attempt: 2, status: "dispatched" },
    ]);

    // The re-dispatch deduplicates again while its execution is live.
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await runs()).toHaveLength(2);

    // A completed execution is a real repair outcome: the signal stays handled
    // even though the evidence has not changed.
    await db.update(heartbeatRuns).set({ status: "completed" }).where(eq(heartbeatRuns.id, reDispatched!.id));
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await runs()).toHaveLength(2);
  });

  it("treats a vanished execution with a live retry as handled and escalates once the bound is reached", async () => {
    const pipeline = await governedPipeline();
    const { companyId, unit } = pipeline;
    const runs = async () => await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));

    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    const [lost] = await runs();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, lost!.id));
    // A live retry of the exact lost run keeps the signal handled: the retry
    // is the execution that will deliver the outcome.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: unit.ownerAgentId!,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      retryOfRunId: lost!.id,
    });
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await runs()).toHaveLength(2);
  });

  it("does not let a vanished repair execution suppress the signal forever", async () => {
    const pipeline = await governedPipeline();
    const { companyId, unit } = pipeline;
    // Every dispatch is lost to process loss; the bounded loop escalates
    // instead of re-dispatching without limit.
    for (let round = 1; round <= 4; round += 1) {
      await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
      const dispatched = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
      for (const run of dispatched) {
        await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
      }
    }
    const [escalated] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unit.id));
    expect(escalated).toMatchObject({ status: "blocked", blocker: { reasonCode: "repair_attempts_exhausted" } });
    expect((await repairAttempts(companyId, unit.id)).filter((attempt) => attempt.status === "exhausted")).toHaveLength(1);
  });

  it("fences candidate evidence to its generation across head changes, PR replacement, and A -> B -> A", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
    await db.insert(deliveryPolicies).values({
      companyId,
      projectId,
      repositoryId: repository.id,
      targetBranch: "main",
      enabled: true,
      autoDeployDisposition: "authorized",
      authorization: {
        approvedByUserId: "user-1",
        approvedAt: "2026-09-01T00:00:00Z",
        statement: "Merge authorized",
        scope: "project",
      },
    });
    const remote = { headSha: HEAD, number: 7 };
    const openRemote = () => {
      const base = openPr(remote.headSha).value;
      return {
        ok: true as const,
        value: {
          ...base,
          number: remote.number,
          url: `https://github.com/acme/widget/pull/${remote.number}`,
        },
      };
    };
    const github = githubStub({
      getPullRequest: async () => openRemote(),
      findOpenPullRequest: async () => openRemote(),
    });
    const { units } = services(github);
    const register = async (headSha: string) => await units.registerCandidate({
      companyId, issue, actor: userActor, headSha, sourceBranch: "delivery/x", artifactReady: true,
    });

    await register(HEAD);
    const first = await units.buildSummary(companyId, issue.id);
    expect(first.candidateGeneration).toBe(1);
    expect(first.headSha).toBe(HEAD);

    // Evidence observed for generation 1 counts for generation 1 only.
    await recordObservedFindings(db, {
      companyId,
      unitId: first.unitId!,
      candidateGeneration: 1,
      headSha: HEAD,
      findings: [{
        externalId: "scm-gen1", severity: "high", title: "P1: gen-1 defect", body: null,
        filePath: null, line: null, url: null, blocking: true, addressed: false, commitSha: HEAD,
      }],
    });
    expect((await units.buildSummary(companyId, issue.id)).review.blockingFindings).toBe(1);

    // A new head is a new generation: readiness and evidence are revoked, and
    // the replacement never inherits the previous candidate's approval.
    remote.headSha = OTHER_HEAD;
    await register(OTHER_HEAD);
    const second = await units.buildSummary(companyId, issue.id);
    expect(second.candidateGeneration).toBe(2);
    expect(second.headSha).toBe(OTHER_HEAD);
    expect(second.review.blockingFindings).toBe(0);
    expect(second.review.status).toBe("unknown");
    expect(second.checks).toEqual([]);
    const [secondUnit] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, second.unitId!));
    expect(secondUnit).toMatchObject({ candidateGeneration: 2, acceptedHeadSha: null });
    // The worker's submit flag is recorded but never presented as an accepted
    // artifact until the exact head is accepted on fresh evidence.
    expect(secondUnit?.artifactReady).toBe(true);
    expect(second.artifactReady).toBe(false);

    // A write read at the previous generation is dropped, not retargeted.
    await units.markBlocked({
      companyId,
      unitId: second.unitId!,
      blocker: { reasonCode: "review_blocking_findings", message: "stale", owner: null, nextAction: null },
      candidateGeneration: 1,
    });
    const [unchanged] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, second.unitId!));
    expect(unchanged).toMatchObject({ status: "in_review", blocker: null, candidateGeneration: 2 });

    // A replacement pull request is a material identity change in its own
    // right, with the head unchanged.
    remote.number = 9;
    await register(remote.headSha);
    const replaced = await units.buildSummary(companyId, issue.id);
    expect(replaced.candidateGeneration).toBe(3);
    expect(replaced.prNumber).toBe(9);
    expect(replaced.headSha).toBe(OTHER_HEAD);

    // A -> B -> A: the revision returns, the generation does not, so the
    // generation-1 findings never surface as current evidence again.
    remote.headSha = HEAD;
    await register(HEAD);
    const backToA = await units.buildSummary(companyId, issue.id);
    expect(backToA.candidateGeneration).toBe(4);
    expect(backToA.headSha).toBe(HEAD);
    expect(backToA.review.blockingFindings).toBe(0);
    expect(backToA.review.status).toBe("unknown");

    // An observation that arrives after the candidate moved on is discarded
    // rather than recorded as evidence for the new one.
    expect(await recordObservedFindings(db, {
      companyId,
      unitId: backToA.unitId!,
      candidateGeneration: 3,
      headSha: "d".repeat(40),
      findings: [{
        externalId: "scm-late", severity: "high", title: "P1: late", body: null,
        filePath: null, line: null, url: null, blocking: true, addressed: false, commitSha: "d".repeat(40),
      }],
    })).toEqual({ recorded: false });
    expect((await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, backToA.unitId!)))
      .map((row) => row.externalId)).toEqual(["scm-gen1"]);
  });

  /**
   * Minimal candidate-generation fixture: one repository, one authorized
   * policy, and a GitHub stub whose remote head and PR number the test owns.
   */
  async function candidateFixture() {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
    await db.insert(deliveryPolicies).values({
      companyId,
      projectId,
      repositoryId: repository.id,
      targetBranch: "main",
      enabled: true,
      autoDeployDisposition: "authorized",
      authorization: {
        approvedByUserId: "user-1",
        approvedAt: "2026-09-01T00:00:00Z",
        statement: "Merge authorized",
        scope: "project",
      },
    });
    const remote = { headSha: HEAD, number: 7 };
    const openRemote = () => {
      const base = openPr(remote.headSha).value;
      return {
        ok: true as const,
        value: {
          ...base,
          number: remote.number,
          url: `https://github.com/acme/widget/pull/${remote.number}`,
        },
      };
    };
    const github = githubStub({
      getPullRequest: async () => openRemote(),
      findOpenPullRequest: async () => openRemote(),
    });
    const { units } = services(github);
    const register = async (headSha: string) => await units.registerCandidate({
      companyId,
      issue,
      actor: userActor,
      headSha,
      sourceBranch: "delivery/x",
      artifactReady: false,
    });
    return { companyId, projectId, repository, issue, remote, github, units, register };
  }

  function observedFinding(externalId: string, addressed = false) {
    return {
      externalId,
      severity: "high",
      title: `P1: ${externalId}`,
      body: null,
      filePath: null,
      line: null,
      url: null,
      blocking: !addressed,
      addressed,
      commitSha: HEAD,
    };
  }

  /**
   * Blocks until `count` backends are provably waiting on a lock. The
   * interleaving tests below must not depend on timing: they wait for the
   * database to report the waiters before releasing the lock they hold.
   */
  async function waitForLockWaiters(count: number) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const result: unknown = await db.execute(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where wait_event_type = 'Lock'
          and query not ilike '%pg_stat_activity%'
          and query ilike '%delivery_%'
      `);
      const rows = Array.isArray(result)
        ? (result as Array<{ waiting: number }>)
        : ((result as { rows?: Array<{ waiting: number }> }).rows ?? []);
      const waiting = Number(rows[0]?.waiting ?? 0);
      if (waiting >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${waiting} lock waiters; expected ${count}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Holds the unit row lock (as a competing transaction would while a write is
   * in flight) until the returned `release` is called.
   */
  async function holdUnitRowLock(unitId: string) {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = db.transaction(async (tx) => {
      await tx
        .select({ id: deliveryUnits.id })
        .from(deliveryUnits)
        .where(eq(deliveryUnits.id, unitId))
        .for("update");
      await released;
    });
    return { release, held };
  }

  it("pauses an observation after its read, registers a replacement, then resumes it without touching the newer candidate", async () => {
    const { companyId, issue, remote, units } = await candidateFixture();
    const first = await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    const unitId = first.unit.id;

    // The unit row is locked, so everything below is deterministic: the
    // observation blocks first, the replacement queues behind it, and the
    // release resumes them in that order.
    const lock = await holdUnitRowLock(unitId);
    const observation = recordObservedFindings(db, {
      companyId,
      unitId,
      candidateGeneration: 1,
      headSha: HEAD,
      findings: [observedFinding("scm-1")],
    });
    await waitForLockWaiters(1);

    remote.headSha = OTHER_HEAD;
    remote.number = 9;
    const replacement = units.registerCandidate({
      companyId, issue, actor: userActor, headSha: OTHER_HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    await waitForLockWaiters(2);
    lock.release();
    await lock.held;

    expect(await observation).toEqual({ recorded: true });
    const registered = await replacement;
    expect(registered.unit.candidateGeneration).toBe(2);
    expect(registered.unit.headSha).toBe(OTHER_HEAD);

    // The earlier candidate's evidence survives as history...
    const rows = (await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unitId)))
      .sort((left, right) => left.candidateGeneration - right.candidateGeneration);
    expect(rows.map((row) => ({
      externalId: row.externalId,
      generation: row.candidateGeneration,
      headSha: row.headSha,
      state: row.state,
    }))).toEqual([{ externalId: "scm-1", generation: 1, headSha: HEAD, state: "stale" }]);

    // ...and the replacement owns no inherited evidence: nothing was written
    // against generation 2 by the observation that belonged to generation 1.
    const summaryAfterReplacement = await units.buildSummary(companyId, issue.id);
    expect(summaryAfterReplacement.candidateGeneration).toBe(2);
    expect(summaryAfterReplacement.review.blockingFindings).toBe(0);

    // Newer evidence for the new candidate lands beside the history row and is
    // the only row that counts as current.
    await recordObservedFindings(db, {
      companyId,
      unitId,
      candidateGeneration: 2,
      headSha: OTHER_HEAD,
      findings: [observedFinding("scm-1")],
    });
    const afterNewEvidence = (await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unitId)))
      .sort((left, right) => left.candidateGeneration - right.candidateGeneration);
    expect(afterNewEvidence.map((row) => ({
      generation: row.candidateGeneration,
      headSha: row.headSha,
      state: row.state,
    }))).toEqual([
      { generation: 1, headSha: HEAD, state: "stale" },
      { generation: 2, headSha: OTHER_HEAD, state: "open" },
    ]);
    expect((await units.buildSummary(companyId, issue.id)).review.blockingFindings).toBe(1);
  });

  it("discards an observation whose candidate was replaced while it was paused", async () => {
    const { companyId, issue, remote, units } = await candidateFixture();
    const first = await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    const unitId = first.unit.id;

    // This time the replacement is queued first: by the time the observation's
    // read runs, the unit already describes generation 2.
    const lock = await holdUnitRowLock(unitId);
    remote.headSha = OTHER_HEAD;
    remote.number = 9;
    const replacement = units.registerCandidate({
      companyId, issue, actor: userActor, headSha: OTHER_HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    await waitForLockWaiters(1);
    const observation = recordObservedFindings(db, {
      companyId,
      unitId,
      candidateGeneration: 1,
      headSha: HEAD,
      findings: [observedFinding("scm-1")],
    });
    await waitForLockWaiters(2);
    lock.release();
    await lock.held;

    const registered = await replacement;
    expect(registered.unit.candidateGeneration).toBe(2);
    expect(await observation).toEqual({ recorded: false });

    // Nothing was written for the new candidate, and its own state is exactly
    // what it registered — the stale snapshot neither blocked nor described it.
    expect(await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unitId))).toEqual([]);
    const [after] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unitId));
    expect(after).toMatchObject({
      candidateGeneration: 2,
      headSha: OTHER_HEAD,
      prNumber: 9,
      status: "in_review",
      acceptedHeadSha: null,
      blocker: null,
    });
    // The issue was not moved to review by the stale observation either.
    expect((await units.buildSummary(companyId, issue.id)).review.status).toBe("unknown");
  });

  it("keeps generation-scoped finding history instead of overwriting the earlier candidate's rows", async () => {
    const { companyId, issue, remote, units } = await candidateFixture();
    const first = await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    const unitId = first.unit.id;
    await recordObservedFindings(db, {
      companyId, unitId, candidateGeneration: 1, headSha: HEAD, findings: [observedFinding("scm-1")],
    });

    remote.headSha = OTHER_HEAD;
    remote.number = 9;
    const replacement = await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: OTHER_HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    expect(replacement.unit.candidateGeneration).toBe(2);
    await recordObservedFindings(db, {
      companyId, unitId, candidateGeneration: 2, headSha: OTHER_HEAD, findings: [observedFinding("scm-1")],
    });

    const rows = (await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unitId)))
      .sort((left, right) => left.candidateGeneration - right.candidateGeneration);
    // One row per candidate: the first candidate's record is still there, with
    // its own head and its own retirement, and the new candidate has its own.
    expect(rows.map((row) => ({
      externalId: row.externalId,
      generation: row.candidateGeneration,
      headSha: row.headSha,
      state: row.state,
    }))).toEqual([
      { externalId: "scm-1", generation: 1, headSha: HEAD, state: "stale" },
      { externalId: "scm-1", generation: 2, headSha: OTHER_HEAD, state: "open" },
    ]);
    // Only the current generation's row is live evidence.
    const summary = await units.buildSummary(companyId, issue.id);
    expect(summary.candidateGeneration).toBe(2);
    expect(summary.review.blockingFindings).toBe(1);
    expect(summary.review.headSha).toBeNull();
  });

  it("carries a recorded dispute onto the same finding's row for a new candidate", async () => {
    const { companyId, issue, remote, units } = await candidateFixture();
    const first = await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    const unitId = first.unit.id;
    await recordObservedFindings(db, {
      companyId, unitId, candidateGeneration: 1, headSha: HEAD, findings: [observedFinding("scm-1")],
    });
    const [gen1] = await db.select().from(deliveryFindings).where(and(
      eq(deliveryFindings.unitId, unitId),
      eq(deliveryFindings.candidateGeneration, 1),
    ));
    await units.recordFindingDisposition({
      companyId,
      unitId,
      actor: userActor,
      findingId: gen1!.id,
      disposition: "disputed",
      explanation: "Intentional retry: the duplicate dispatch is bounded.",
    });

    // The provider reports the same finding again on the replacement candidate.
    remote.headSha = OTHER_HEAD;
    remote.number = 9;
    await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: OTHER_HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    await recordObservedFindings(db, {
      companyId, unitId, candidateGeneration: 2, headSha: OTHER_HEAD, findings: [observedFinding("scm-1")],
    });

    const rows = (await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unitId)))
      .sort((left, right) => left.candidateGeneration - right.candidateGeneration);
    expect(rows).toMatchObject([
      {
        candidateGeneration: 1,
        headSha: HEAD,
        state: "disputed",
        disposition: "disputed",
        dispositionExplanation: "Intentional retry: the duplicate dispatch is bounded.",
        dispositionActorType: "user",
      },
      {
        candidateGeneration: 2,
        headSha: OTHER_HEAD,
        state: "disputed",
        disposition: "disputed",
        dispositionExplanation: "Intentional retry: the duplicate dispatch is bounded.",
        dispositionActorType: "user",
      },
    ]);
    // A resubmission never silently un-disputes a recorded human decision: the
    // dispute still blocks, and it is visible as unresolved evidence.
    const summary = await units.buildSummary(companyId, issue.id);
    expect(summary.candidateGeneration).toBe(2);
    expect(summary.review.blockingFindings).toBe(1);
  });

  it("never resurrects a terminal unit when a submission races the merge", async () => {
    const { companyId, issue, remote, units } = await candidateFixture();
    const first = await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    const unitId = first.unit.id;

    // The unit merges while the next candidate is being verified (the submit
    // path reads the unit before the GitHub bind, so this window is real).
    await db.update(deliveryUnits).set({
      status: "merged",
      mergedAt: new Date(),
      mergedSha: HEAD,
      acceptedHeadSha: HEAD,
    }).where(eq(deliveryUnits.id, unitId));

    remote.headSha = OTHER_HEAD;
    remote.number = 9;
    const second = await units.registerCandidate({
      companyId, issue, actor: userActor, headSha: OTHER_HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });

    // The terminal unit keeps its merge, and the candidate registers as a new
    // unit instead of reopening it.
    expect(second.created).toBe(true);
    expect(second.unit.id).not.toBe(unitId);
    expect(second.unit.candidateGeneration).toBe(1);
    const [merged] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unitId));
    expect(merged).toMatchObject({
      status: "merged",
      candidateGeneration: 1,
      headSha: HEAD,
      acceptedHeadSha: HEAD,
      mergedSha: HEAD,
    });

    // An in-flight evidence write is refused by the write itself, not only by
    // the caller's earlier read: a merge that lands in between is never
    // reopened by a blocker that was decided before it.
    await units.markBlocked({
      companyId,
      unitId,
      blocker: { reasonCode: "checks_failing", message: "stale blocker", owner: null, nextAction: null },
      candidateGeneration: 1,
    });
    const [stillMerged] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unitId));
    expect(stillMerged).toMatchObject({ status: "merged", blocker: null, mergedSha: HEAD });
  });

  it("entitles a task to delivery only through an explicit candidate or covered-by handoff", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const primary = await seedIssue(companyId, projectId, "in_progress");
    const linkedOnly = await seedIssue(companyId, projectId, "in_progress");
    // A pull request that merely links the task is not a delivery candidate.
    await db.insert(issueWorkProducts).values({
      companyId,
      projectId,
      issueId: linkedOnly.id,
      type: "pull_request",
      provider: "github",
      externalId: "99",
      title: "Mentions the task",
      url: "https://github.com/acme/widget/pull/99",
      status: "open",
    });
    const github = githubStub({
      findOpenPullRequest: async () => openPr(HEAD),
      getPullRequest: async () => openPr(HEAD),
    });
    const { units } = services(github);
    const delivery = deliveryService(db, { toolGateway: greptileToolGateway({}) });
    // Registering a candidate needs a policy row naming a verified repository;
    // the policy stays disabled so it does not enroll the whole project, which
    // is what this test is about.
    await db.insert(deliveryPolicies).values({
      companyId,
      projectId,
      repositoryId: repository.id,
      targetBranch: "main",
      enabled: false,
    });

    // Nothing is enrolled while only the pull-request link exists.
    expect((await delivery.listSummaries(companyId)).map((summary) => summary.issueId)).toEqual([]);

    // An explicit candidate registers exactly its own issue.
    await units.registerCandidate({
      companyId, issue: primary, actor: userActor, headSha: HEAD, sourceBranch: "delivery/x", artifactReady: false,
    });
    expect((await delivery.listSummaries(companyId)).map((summary) => summary.issueId)).toEqual([primary.id]);

    // An explicit covered-by handoff is what entitles the linked task — the
    // pull-request mention never did.
    await units.registerCandidate({
      companyId, issue: primary, actor: userActor, headSha: HEAD, sourceBranch: "delivery/x",
      artifactReady: false, coveredIssueIds: [linkedOnly.id],
    });
    expect((await delivery.listSummaries(companyId)).map((summary) => summary.issueId).sort())
      .toEqual([primary.id, linkedOnly.id].sort());
    expect(repository.id).toBeTruthy();
  });

  it("drives governed Greptile evidence through repair, a fresh review, and a merged receipt", async () => {
    const pipeline = await governedPipeline();
    const { companyId, unit } = pipeline;

    // 1. A blocking finding on the current head blocks, is persisted with its
    // real identity and reviewed head, and requests exactly one repair.
    expect(await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "webhook" }))
      .toMatchObject({ status: "blocked", blocker: { reasonCode: "review_blocking_findings" } });
    const findings = await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unit.id));
    expect(findings).toMatchObject([{
      externalId: "scm-1",
      severity: "high",
      state: "open",
      headSha: HEAD,
      title: "P1: duplicate dispatch",
    }]);
    expect(await repairAttempts(companyId, unit.id)).toHaveLength(1);
    const [blocked] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unit.id));
    expect(blocked?.acceptedHeadSha).toBeNull();

    // 2. Polling the same evidence again is not a new repair.
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" });
    expect(await repairAttempts(companyId, unit.id)).toHaveLength(1);

    // 3. The provider marks the finding addressed: the persisted state follows
    // the provider and the unit becomes accepted, ready, and mergeable.
    pipeline.provider.addressed = true;
    expect(await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" }))
      .toMatchObject({ status: "ready_to_merge", merged: false });
    const resolved = await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unit.id));
    expect(resolved).toMatchObject([{ externalId: "scm-1", state: "already_addressed" }]);
    const [ready] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unit.id));
    expect(ready).toMatchObject({ acceptedHeadSha: HEAD, status: "ready_to_merge" });
    expect(pipeline.statusWrites).toContain("ready_to_merge");

    // 4. The merge and its receipt use the same exact-head Greptile contract.
    const leased = await pipeline.queue.leaseNext({
      companyId, repositoryId: pipeline.repository.id, targetBranch: "main", leaseOwner: "sweep",
    });
    const outcome = await pipeline.executor.attemptMerge({
      companyId, unitId: unit.id, lease: { leaseOwner: "sweep", leaseEpoch: leased!.leaseEpoch },
    });
    expect(outcome).toMatchObject({ merged: true, blocked: false });
    expect(pipeline.merges).toEqual([HEAD]);
    const [merged] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unit.id));
    expect(merged).toMatchObject({ status: "merged", mergedSha: HEAD, acceptedHeadSha: HEAD });
    const [receipt] = await db.select().from(deliveryReceipts).where(eq(deliveryReceipts.unitId, unit.id));
    expect(receipt?.provenance).toMatchObject({
      acceptedHeadSha: HEAD,
      mergedSha: HEAD,
      reviewStatus: "approved",
      blockingFindings: 0,
    });
  });

  it("waits on an in-flight external review without spending a repair attempt", async () => {
    const pipeline = await governedPipeline({ reviewState: "IN_PROGRESS" });
    const { companyId, unit } = pipeline;

    expect(await pipeline.reconciler.reconcileUnit({ companyId, unitId: unit.id, trigger: "sweep" }))
      .toMatchObject({ status: "blocked", blocker: { reasonCode: "review_pending" } });
    expect(await repairAttempts(companyId, unit.id)).toHaveLength(0);
    expect(await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unit.id)))
      .toMatchObject([{ externalId: "scm-1", state: "open" }]);
    const [waiting] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, unit.id));
    expect(waiting?.acceptedHeadSha).toBeNull();

    // The completed review of the same head then authorizes the repair loop.
    const completed = await governedPipeline();
    expect(await completed.reconciler.reconcileUnit({ companyId: completed.companyId, unitId: completed.unit.id, trigger: "sweep" }))
      .toMatchObject({ blocker: { reasonCode: "review_blocking_findings" } });
    expect(await repairAttempts(completed.companyId, completed.unit.id)).toHaveLength(1);
  });

  it("distinguishes a stale completed review from an unavailable provider without burning repair attempts", async () => {
    // A completed review that names an older revision is stale evidence: the
    // wait is external, so it blocks without a repair attempt.
    const stale = await governedPipeline({ revision: OTHER_HEAD });
    expect(await stale.reconciler.reconcileUnit({ companyId: stale.companyId, unitId: stale.unit.id, trigger: "sweep" }))
      .toMatchObject({ status: "blocked", blocker: { reasonCode: "review_head_stale" } });
    expect(await repairAttempts(stale.companyId, stale.unit.id)).toHaveLength(0);
    const [staleUnit] = await db.select().from(deliveryUnits).where(eq(deliveryUnits.id, stale.unit.id));
    expect(staleUnit?.acceptedHeadSha).toBeNull();

    // An unreadable provider is unavailable, not stale.
    const unavailable = await governedPipeline({ failRead: true });
    expect(await unavailable.reconciler.reconcileUnit({ companyId: unavailable.companyId, unitId: unavailable.unit.id, trigger: "sweep" }))
      .toMatchObject({ status: "blocked", blocker: { reasonCode: "greptile_unavailable" } });
    expect(await repairAttempts(unavailable.companyId, unavailable.unit.id)).toHaveLength(0);
  });

  it("stales findings a fresh zero-finding snapshot omits without erasing dispositions", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
    const [unit] = await db.insert(deliveryUnits).values({
      companyId, repositoryId: repository.id, primaryIssueId: issue.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD,
    }).returning();
    const seedFinding = async (externalId: string, state: string, disposition: string | null) => {
      await db.insert(deliveryFindings).values({
        companyId, unitId: unit!.id, source: "greptile", externalId,
        severity: "high", title: externalId, headSha: HEAD,
        state: state as "open",
        disposition: disposition as "fixed" | null,
      });
    };
    await seedFinding("scm-open", "open", null);
    await seedFinding("scm-fixed", "fixed", "fixed");
    await seedFinding("scm-disputed", "disputed", "disputed");
    await seedFinding("scm-addressed", "already_addressed", "already_addressed");

    await recordObservedFindings(db, {
      companyId, unitId: unit!.id, candidateGeneration: unit!.candidateGeneration, headSha: HEAD, findings: [],
    });

    const rows = await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unit!.id));
    const stateOf = (externalId: string) => rows.find((row) => row.externalId === externalId)?.state;
    expect(stateOf("scm-open")).toBe("stale");
    expect(stateOf("scm-fixed")).toBe("fixed");
    expect(stateOf("scm-disputed")).toBe("disputed");
    expect(stateOf("scm-addressed")).toBe("already_addressed");
  });

  it("keeps a disputed finding blocking and reopens a fixed one the provider still reports", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
    const [unit] = await db.insert(deliveryUnits).values({
      companyId, repositoryId: repository.id, primaryIssueId: issue.id,
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD,
    }).returning();
    const seedFinding = async (externalId: string, state: string, disposition: string | null) => {
      await db.insert(deliveryFindings).values({
        companyId, unitId: unit!.id, source: "greptile", externalId,
        severity: "high", title: externalId, headSha: HEAD,
        state: state as "open",
        disposition: disposition as "fixed" | null,
      });
    };
    await seedFinding("scm-fixed", "fixed", "fixed");
    await seedFinding("scm-disputed", "disputed", "disputed");

    const finding = (externalId: string, addressed: boolean) => ({
      externalId, severity: "high", title: externalId, body: null,
      filePath: null, line: null, url: null, blocking: !addressed, addressed, commitSha: HEAD,
    });
    await recordObservedFindings(db, {
      companyId, unitId: unit!.id, candidateGeneration: unit!.candidateGeneration, headSha: HEAD,
      findings: [finding("scm-fixed", false), finding("scm-disputed", true)],
    });

    const rows = await db.select().from(deliveryFindings).where(eq(deliveryFindings.unitId, unit!.id));
    const stateOf = (externalId: string) => rows.find((row) => row.externalId === externalId)?.state;
    // Still reported and not addressed: reopened. Disputed: the operator
    // decision outranks the provider's own addressed flag.
    expect(stateOf("scm-fixed")).toBe("open");
    expect(stateOf("scm-disputed")).toBe("disputed");
  });
});

describe("governed Greptile ingestion", () => {
  const correlation = { host: "github.com", connectionId: null, owner: "acme", repo: "widget" };
  const baseInput = {
    companyId: "22222222-2222-4222-8222-222222222222",
    connectionId: "33333333-3333-4333-8333-333333333333",
    repositoryName: "acme/widget",
    defaultBranch: "main",
    prNumber: 7,
    correlation,
  };

  function greptileGitHub(overrides: Partial<GitHubDeliveryClient> = {}, reviewedHead: string | null = null) {
    return githubStub({
      getReviews: async () => ({
        ok: true,
        value: {
          status: "commented", headSha: reviewedHead, approvedHeadSha: null,
          approvals: [], blockingFindings: 0,
          reviews: reviewedHead ? [{
            login: "greptile-apps[bot]", state: "COMMENTED",
            commitSha: reviewedHead, submittedAt: "2026-09-10T11:59:08Z",
          }] : [],
        },
      }),
      ...overrides,
    });
  }
  function unaddressedFinding() {
    return {
      id: "internal-1",
      commentId: "scm-1",
      body: "Duplicate dispatch",
      filePath: "dispatch.ts",
      lineStart: 12,
      isGreptileComment: true,
      addressed: false,
    };
  }

  it("correlates provider findings with the authoritative GitHub commit for the reviewed head", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([{ id: "scm-1", commitSha: HEAD }]) }),
      toolGateway: greptileToolGateway({ comments: [unaddressedFinding()] }),
    });
    const result = await greptile.read(baseInput);
    expect(result).toMatchObject({
      ok: true,
      status: "changes_requested",
      reviewState: "completed",
      headSha: HEAD,
      blockingFindings: 1,
      providerFindings: 1,
      findings: [{ externalId: "scm-1", line: 12, blocking: true, commitSha: HEAD }],
    });
  });

  it("reports the revision GitHub recorded for a finding instead of the candidate head", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([{ id: "scm-1", commitSha: OTHER_HEAD }]) }),
      toolGateway: greptileToolGateway({ comments: [unaddressedFinding()] }),
    });
    // The caller's candidate is HEAD; the reviewed revision is what GitHub says
    // the comment was written against.
    expect(await greptile.read(baseInput)).toMatchObject({ ok: true, headSha: OTHER_HEAD, blockingFindings: 1 });
  });

  it("never invents a reviewed head when no finding resolves to an authoritative commit", async () => {
    const greptile = greptileReviewService({} as Db, {
      // The pull request has no GitHub review comments for the reported ids.
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }),
      toolGateway: greptileToolGateway({ comments: [unaddressedFinding()] }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({ ok: false, errorCode: "provider_unknown" });
  });

  it("fails closed when the authoritative GitHub correlation read fails", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub(),
      toolGateway: greptileToolGateway({ comments: [unaddressedFinding()] }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({ ok: false, errorCode: "provider_unknown" });
  });

  it("treats a comment id GitHub records against two commits as unresolved", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({
        getReviewComments: async () => reviewComments([
          { id: "scm-1", commitSha: HEAD },
          { id: "scm-1", commitSha: OTHER_HEAD },
        ]),
      }),
      toolGateway: greptileToolGateway({ comments: [unaddressedFinding()] }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({ ok: false, errorCode: "provider_unknown" });
  });

  it("blocks an unclassified finding and an addressed one without reopening it", async () => {
    const noSeverity = { id: "internal-9", commentId: "scm-9", body: "Swallowed error", filePath: "client.ts", isGreptileComment: true };
    const addressed = { id: "internal-2", commentId: "scm-2", body: "Previously fixed", isGreptileComment: true, addressed: true };
    const lowPriority = { id: "internal-3", commentId: "scm-3", body: "Nit", priority: "P2", isGreptileComment: true };
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({
        getReviewComments: async () => reviewComments([
          { id: "scm-9", commitSha: HEAD },
          { id: "scm-2", commitSha: HEAD },
          { id: "scm-3", commitSha: HEAD },
        ]),
      }),
      toolGateway: greptileToolGateway({ comments: [noSeverity, addressed, lowPriority] }),
    });
    const result = await greptile.read(baseInput);
    expect(result).toMatchObject({
      ok: true,
      status: "changes_requested",
      blockingFindings: 1,
      providerFindings: 3,
      findings: [
        { externalId: "scm-9", severity: "unknown", blocking: true },
        { externalId: "scm-2", blocking: false, addressed: true },
        { externalId: "scm-3", severity: "medium", blocking: false },
      ],
    });
  });

  it("reports an in-flight review as pending without a fabricated head", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }),
      toolGateway: greptileToolGateway({ review: { status: "IN_PROGRESS" } }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({
      ok: true,
      status: "pending",
      headSha: null,
    });
    // With a finding that resolves the revision, the same in-flight review is a
    // readable pending review rather than an unknown one.
    const pending = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([{ id: "scm-1", commitSha: HEAD }]) }),
      toolGateway: greptileToolGateway({ review: { status: "IN_PROGRESS" }, comments: [unaddressedFinding()] }),
    });
    expect(await pending.read(baseInput)).toMatchObject({
      ok: true,
      status: "changes_requested",
      reviewState: "pending",
      headSha: HEAD,
      blockingFindings: 1,
    });
  });

  it("reads the documented vendor shape: priority in the body, addressed flag, nested comments", async () => {
    const real = {
      id: "internal-1",
      commentId: "scm-1",
      body: "P1: duplicate dispatch",
      filePath: "dispatch.ts",
      lineStart: 30,
      lineEnd: 36,
      isGreptileComment: true,
      addressed: false,
    };
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([{ id: "scm-1", commitSha: HEAD }]) }),
      // Comments nested under the merged review object, not at the payload root.
      toolGateway: greptileToolGateway({
        review: { status: "COMPLETED", revision: HEAD, comments: [real] },
        comments: [],
      }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({
      ok: true,
      status: "changes_requested",
      headSha: HEAD,
      blockingFindings: 1,
      findings: [{ externalId: "scm-1", severity: "high", blocking: true, addressed: false, line: 30 }],
    });
  });

  it("does not turn review analysis prose into fabricated blocking findings", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }, HEAD),
      toolGateway: greptileToolGateway({
        review: { status: "COMPLETED", revision: HEAD, reviewAnalysis: { rows: [{ id: "a1", body: "Consider renaming this method" }] } },
        comments: [],
      }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({
      ok: true,
      status: "none",
      headSha: HEAD,
      blockingFindings: 0,
      findings: [],
    });
  });

  it("blocks a completed review whose own verdict failed without findings", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }, HEAD),
      toolGateway: greptileToolGateway({ review: { status: "COMPLETED", state: "FAILED", revision: HEAD } }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({
      ok: true,
      status: "changes_requested",
      reviewState: "completed",
      headSha: HEAD,
      blockingFindings: 0,
    });
  });

  it("treats a review payload without a review state as unknown", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }),
      toolGateway: greptileToolGateway({ review: { notAReviewField: true } }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({ ok: false, errorCode: "provider_unknown" });
  });

  it("binds a clean review with no inline findings to the GitHub review commit", async () => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }, HEAD),
      toolGateway: greptileToolGateway({ review: { status: "COMPLETED", revision: OTHER_HEAD }, comments: [] }),
    });
    expect(await greptile.read(baseInput)).toMatchObject({
      ok: true,
      status: "none",
      reviewState: "completed",
      headSha: HEAD,
      blockingFindings: 0,
      findings: [],
    });
  });

  it("ignores PR overviews and human comments but carries unresolved findings across commits", async () => {
    const finding = { ...unaddressedFinding(), commentId: "PRRC_finding", body: "P1: invalid carrier" };
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({
        getReviewComments: async () => reviewComments([{ id: "PRRC_finding", commitSha: OTHER_HEAD }]),
      }, HEAD),
      toolGateway: {
        readConnectedTool: async ({ toolName }) => ({
          ok: true,
          result: { content: JSON.stringify(toolName === "get_merge_request" ? {
            mergeRequest: {
              id: "pr-54", title: "Implementation", body: "Requested feature",
              codeReviews: [{ status: "COMPLETED" }],
              comments: { greptile: [finding], human: [{ id: "human-1", body: "Thanks" }] },
            },
          } : { comments: [{
            commentId: "IC_overview", body: "<h2>Confidence Score: 4/5</h2>",
            isGreptileComment: true, addressed: false,
          }] }) },
        }),
      },
    });
    expect(await greptile.read(baseInput)).toMatchObject({
      ok: true, headSha: HEAD, blockingFindings: 1,
      findings: [{ externalId: "PRRC_finding", commitSha: OTHER_HEAD, blocking: true }],
    });
  });

  it("waits for the latest review and invalidates completion when new commits arrive", async () => {
    const codeReviews: Array<{ status: string; createdAt: string }> = [];
    let hasNewCommitsSinceReview = false;
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }, HEAD),
      toolGateway: {
        readConnectedTool: async ({ toolName }) => ({
          ok: true,
          result: { content: JSON.stringify(toolName === "get_merge_request"
            ? { mergeRequest: { codeReviews, reviewAnalysis: { hasNewCommitsSinceReview } } }
            : { comments: [] }) },
        }),
      },
    });
    expect(await greptile.read(baseInput)).toMatchObject({ ok: true, reviewState: "pending" });
    codeReviews.push(
      { status: "COMPLETED", createdAt: "2026-09-10T10:00:00Z" },
      { status: "IN_PROGRESS", createdAt: "2026-09-10T11:00:00Z" },
    );
    expect(await greptile.read(baseInput)).toMatchObject({ ok: true, reviewState: "pending" });
    codeReviews[1]!.status = "COMPLETED";
    expect(await greptile.read(baseInput)).toMatchObject({ ok: true, reviewState: "completed", headSha: HEAD });
    hasNewCommitsSinceReview = true;
    expect(await greptile.read(baseInput)).toMatchObject({ ok: true, reviewState: "pending" });
  });

  it.each([
    { content: "provider unavailable" },
    { content: JSON.stringify({ comments: [] }), data: { isError: true }, error: "Provider failed" },
    { content: JSON.stringify({ unexpected: [] }) },
  ])("rejects an unreadable comments snapshot instead of clearing findings: %j", async (result) => {
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }, HEAD),
      toolGateway: {
        readConnectedTool: async ({ toolName }) => ({
          ok: true,
          result: toolName === "get_merge_request"
            ? { content: JSON.stringify({ mergeRequest: { codeReviews: [{ status: "COMPLETED" }] } }) }
            : result,
        }),
      },
    });
    expect(await greptile.read(baseInput)).toMatchObject({ ok: false, errorCode: "provider_unknown" });
  });

  it("does not accept an older completion when a pending review has no usable date", async () => {
    let incompleteReview: Record<string, unknown> = { status: "IN_PROGRESS" };
    const greptile = greptileReviewService({} as Db, {
      github: greptileGitHub({ getReviewComments: async () => reviewComments([]) }, HEAD),
      toolGateway: {
        readConnectedTool: async ({ toolName }) => ({
          ok: true,
          result: { content: JSON.stringify(toolName === "get_merge_request"
            ? { mergeRequest: { codeReviews: [
              { status: "COMPLETED", createdAt: "2026-09-10T10:00:00Z" },
              incompleteReview,
            ] } }
            : { comments: [] }) },
        }),
      },
    });
    expect(await greptile.read(baseInput)).toMatchObject({ ok: true, reviewState: "pending" });
    incompleteReview = { createdAt: "2026-09-10T11:00:00Z" };
    expect(await greptile.read(baseInput)).toMatchObject({ ok: false, errorCode: "provider_unknown" });
  });
});
