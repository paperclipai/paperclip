import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
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
import { deliveryUnitService, type DeliveryActor } from "../services/delivery/units.js";
import { deliveryService } from "../services/delivery/service.js";
import { greptileReviewService } from "../services/delivery/greptile.js";
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
    await db.delete(issues);
    await db.delete(projects);
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

  function services(github: GitHubDeliveryClient) {
    const events = deliveryEventService(db as unknown as Db);
    const policy = deliveryPolicyService(db as unknown as Db, { github });
    const queue = deliveryQueueService(db as unknown as Db);
    const units = deliveryUnitService(db as unknown as Db, { policy, queue, events, github });
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
    await queue.enqueue({ companyId, repositoryId: repository.id, targetBranch: "main", unitId: unitA.id, priority: "medium" });
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
    input: { reviewState?: "COMPLETED" | "IN_PROGRESS"; revision?: string; failRead?: boolean } = {},
  ) {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId, "https://github.com/acme/widget");
    const repository = await seedRepository(companyId);
    const issue = await seedIssue(companyId, projectId);
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
      targetBranch: "main", sourceBranch: "delivery/x", headSha: HEAD, prNumber: 7, status: "submitted",
    }).returning();
    await db.insert(deliveryUnitIssues).values({ companyId, unitId: unit!.id, issueId: issue.id, role: "primary" });

    const provider = { addressed: false };
    const merges: string[] = [];
    const statusWrites: string[] = [];
    const github = githubStub({
      getPullRequest: async () => openPr(HEAD),
      getChecks: async () => ({ ok: true, value: [] }),
      getReviews: async () => ({
        ok: true,
        value: {
          status: "commented", headSha: HEAD, approvedHeadSha: HEAD,
          approvals: [{ login: "independent-reviewer", commitSha: HEAD }],
          blockingFindings: 0, reviews: [],
        },
      }),
      getReviewComments: async () => reviewComments([{ id: "scm-1", commitSha: input.revision ?? HEAD }]),
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
          commentId: "scm-1",
          // The real payload carries no severity field: the priority is only in
          // the comment body, and `addressed` is the vendor's own flag.
          body: "P1: duplicate dispatch",
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
    const { queue, ...dependencies } = services(github);
    const setIssueStatus = async ({ status }: { status: string }) => { statusWrites.push(status); };
    const deps = { ...dependencies, queue, github, greptile, setIssueStatus };
    const reconciler = deliveryReconciler(db, deps);
    const executor = deliveryMergeExecutor(db, { ...deps, reconciler });
    await queue.enqueue({
      companyId, repositoryId: repository.id, targetBranch: "main", unitId: unit!.id, priority: "medium",
    });
    return { companyId, projectId, repository, issue, unit: unit!, provider, merges, statusWrites, github, greptile, queue, reconciler, executor };
  }

  async function repairAttempts(companyId: string, unitId: string) {
    return await db
      .select()
      .from(deliveryRepairAttempts)
      .where(and(eq(deliveryRepairAttempts.companyId, companyId), eq(deliveryRepairAttempts.unitId, unitId)));
  }

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

    await recordObservedFindings(db, { companyId, unitId: unit!.id, headSha: HEAD, findings: [] });

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
      companyId, unitId: unit!.id, headSha: HEAD,
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
});
