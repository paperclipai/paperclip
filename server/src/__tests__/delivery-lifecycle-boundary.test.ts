import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  deliveryEvents,
  deliveryFindings,
  deliveryPolicies,
  deliveryQueueEntries,
  deliveryReconciliations,
  deliveryRepairAttempts,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  issues,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { deliveryEventService } from "../services/delivery/events.js";
import { createDeliveryDoneGate } from "../services/delivery/done-gate.js";
import { deliveryPolicyService } from "../services/delivery/policy.js";
import { deliveryQueueService, type DeliveryQueueEntryRow } from "../services/delivery/queue.js";
import { deliveryReconciliationService } from "../services/delivery/reconciliation.js";
import { deliveryUnitService, type DeliveryActor } from "../services/delivery/units.js";
import { deliveryService } from "../services/delivery/service.js";
import { greptileReviewService } from "../services/delivery/greptile.js";
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
    mergePullRequest: async () => failure,
    enqueuePullRequest: async () => failure,
    compareCommits: async () => failure,
    findOpenPullRequest: async () => failure,
    ...overrides,
  } as GitHubDeliveryClient;
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

    let leaseAttempts: Promise<Array<DeliveryQueueEntryRow | null>> | undefined;
    try {
      await db.transaction(async (tx) => {
        // Hold the head row so both sweeps reach their lease decision before
        // either can commit. The fixed path waits on the repository lock.
        await tx.execute(sql`select id from delivery_queue_entries where unit_id = ${unitA.id} for update`);
        leaseAttempts = Promise.all([
          queue.leaseNext({ companyId, repositoryId: repository.id, targetBranch: "main", leaseOwner: "sweep-1" }),
          queue.leaseNext({ companyId, repositoryId: repository.id, targetBranch: "main", leaseOwner: "sweep-2" }),
        ]);
        await expect.poll(async () => {
          const [row] = await db.execute<{ count: number }>(sql`
            select count(*)::integer as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
          `);
          return row?.count ?? 0;
        }, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
      });
    } finally {
      await leaseAttempts;
    }
    const leases = await leaseAttempts!;
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
    const readConnectedTool = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { status: "approved", headSha: HEAD } })
      .mockResolvedValueOnce({ ok: false, errorCode: "tool_call_failed", message: "comments unreadable" });
    const greptile = greptileReviewService({} as unknown as Db, { toolGateway: { readConnectedTool } });
    const result = await greptile.read({
      companyId: randomUUID(),
      connectionId: randomUUID(),
      repositoryName: "widget",
      defaultBranch: "main",
      prNumber: 7,
      submittedHeadSha: HEAD,
      acceptedHeadSha: null,
      checks: [],
    });
    expect(result).toMatchObject({ ok: false, errorCode: "tool_call_failed" });
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
});
