import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  deliveryFindings,
  deliveryPolicies,
  deliveryQueueEntries,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  externalObjectMentions,
  externalObjects,
  issueRelations,
  issueWorkProducts,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_CHILD_REFS_PER_ISSUE,
  issueOverviewService,
} from "../services/issue-overviews.js";
import { deliveryPriorityRank } from "../services/delivery/queue.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue overview projection tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue overview projection", () => {
  let db!: Db;
  let svc!: ReturnType<typeof issueOverviewService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-overview-");
    db = createDb(tempDb.connectionString);
    svc = issueOverviewService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(deliveryFindings);
    await db.delete(deliveryQueueEntries);
    await db.delete(deliveryUnitIssues);
    await db.delete(deliveryUnits);
    await db.delete(deliveryPolicies);
    await db.delete(deliveryRepositories);
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueWorkProducts);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Overview ${companyId.slice(0, 6)}`,
      issuePrefix: `OV${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createProject(companyId: string, name: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name, color: "#123456" });
    return projectId;
  }

  async function createIssue(input: {
    companyId: string;
    status: string;
    title?: string;
    identifier?: string;
    projectId?: string | null;
    parentId?: string | null;
    unblockDescriptor?: Record<string, unknown> | null;
    executionState?: Record<string, unknown> | null;
    createdAt?: Date;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      title: input.title ?? "Overview issue",
      identifier: input.identifier ?? null,
      status: input.status,
      unblockDescriptor: input.unblockDescriptor ?? null,
      executionState: input.executionState ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return issueId;
  }

  async function createRepository(companyId: string, owner = "acme", name = "widget", host = "github.com") {
    const repositoryId = randomUUID();
    await db.insert(deliveryRepositories).values({ id: repositoryId, companyId, owner, name, host });
    return repositoryId;
  }

  async function createUnit(input: {
    companyId: string;
    repositoryId: string;
    primaryIssueId: string;
    coveredIssueIds?: string[];
    status: string;
    projectId?: string | null;
    targetBranch?: string;
    prNumber?: number | null;
    prUrl?: string | null;
    blocker?: Record<string, unknown> | null;
    nextAction?: string | null;
    metadata?: Record<string, unknown>;
    artifactReady?: boolean;
    headSha?: string | null;
    acceptedHeadSha?: string | null;
    mergedAt?: Date | null;
    mergedSha?: string | null;
    lastEventAt?: Date | null;
    candidateGeneration?: number;
  }) {
    const unitId = randomUUID();
    await db.insert(deliveryUnits).values({
      id: unitId,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      repositoryId: input.repositoryId,
      primaryIssueId: input.primaryIssueId,
      targetBranch: input.targetBranch ?? "main",
      sourceBranch: "feat/overview",
      status: input.status,
      candidateGeneration: input.candidateGeneration ?? 1,
      prNumber: input.prNumber ?? null,
      prUrl: input.prUrl ?? null,
      blocker: input.blocker ?? null,
      nextAction: input.nextAction ?? null,
      metadata: input.metadata ?? {},
      artifactReady: input.artifactReady ?? false,
      headSha: input.headSha ?? null,
      acceptedHeadSha: input.acceptedHeadSha ?? null,
      mergedAt: input.mergedAt ?? null,
      mergedSha: input.mergedSha ?? null,
      lastEventAt: input.lastEventAt ?? null,
    });
    await db.insert(deliveryUnitIssues).values([
      { companyId: input.companyId, unitId, issueId: input.primaryIssueId, role: "primary" },
      ...(input.coveredIssueIds ?? []).map((issueId) => ({
        companyId: input.companyId,
        unitId,
        issueId,
        role: "covered",
      })),
    ]);
    return unitId;
  }

  async function createPullRequestObject(input: {
    companyId: string;
    issueId: string;
    number: number;
    statusKey: string;
    owner?: string;
    repo?: string;
    host?: string;
    /**
     * Record the repository the way a non-GitHub provider does: one
     * `repository` string instead of the split `owner`/`repo` pair.
     */
    repository?: string;
    state?: string;
    merged?: boolean;
    draft?: boolean;
    liveness?: "fresh" | "stale" | "unknown" | "auth_required" | "unreachable";
    nextRefreshAt?: Date | null;
  }) {
    const objectId = randomUUID();
    const owner = input.owner ?? "acme";
    const repo = input.repo ?? "widget";
    const host = input.host ?? "github.com";
    const repository = input.repository ?? `${owner}/${repo}`;
    await db.insert(externalObjects).values({
      id: objectId,
      companyId: input.companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: `${repository}#${input.number}`,
      sanitizedCanonicalUrl: `https://${host}/${repository}/pull/${input.number}`,
      statusKey: input.statusKey,
      statusCategory: "open",
      liveness: input.liveness ?? "fresh",
      lastResolvedAt: new Date("2026-02-01T10:00:00Z"),
      lastChangedAt: new Date("2026-02-01T10:00:00Z"),
      nextRefreshAt: input.nextRefreshAt === undefined ? new Date("2030-01-01T00:00:00Z") : input.nextRefreshAt,
      remoteVersion: "2026-02-01T10:00:00Z",
      data: {
        provider: "github",
        ...(input.repository ? { repository: input.repository } : { owner, repo }),
        number: input.number,
        state: input.state ?? "open",
        merged: input.merged ?? false,
        draft: input.draft ?? false,
      },
    });
    await db.insert(externalObjectMentions).values({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      sourceKind: "description",
      objectId,
      providerKey: "github",
      objectType: "pull_request",
    });
    return objectId;
  }

  it("projects a blocked review from retained delivery evidence", async () => {
    const companyId = await createCompany();
    const projectId = await createProject(companyId, "Delivery");
    const parentId = await createIssue({ companyId, status: "in_progress", title: "Parent" });
    const issueId = await createIssue({
      companyId,
      status: "blocked",
      title: "Blocked review",
      identifier: "OV-1",
      projectId,
      parentId,
    });
    await createIssue({ companyId, status: "done", parentId: issueId });
    await createIssue({ companyId, status: "cancelled", parentId: issueId });
    const repositoryId = await createRepository(companyId);
    const unitId = await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "blocked",
      projectId,
      prNumber: 12,
      prUrl: "https://github.com/acme/widget/pull/12",
      blocker: {
        reasonCode: "review_blocking_findings",
        message: "Greptile raised one blocking finding",
        owner: "Security Reviewer",
        nextAction: "Address the review finding.",
      },
      nextAction: "Address the review finding.",
      metadata: {
        blockedPhase: "in_review",
        reviewStatus: "changes_requested",
        reviewHeadSha: "a".repeat(40),
        checksHeadSha: "a".repeat(40),
        evidenceGeneration: 1,
        blockingFindings: 1,
      },
      artifactReady: true,
      headSha: "a".repeat(40),
      acceptedHeadSha: "a".repeat(40),
      lastEventAt: new Date("2026-02-02T10:00:00Z"),
    });
    await db.insert(deliveryFindings).values({
      companyId,
      unitId,
      externalId: "finding-1",
      title: "Unbounded query",
      severity: "high",
      state: "open",
      headSha: "a".repeat(40),
      candidateGeneration: 1,
    });
    await db.insert(deliveryFindings).values({
      companyId,
      unitId,
      externalId: "finding-2",
      title: "Already fixed",
      severity: "low",
      state: "fixed",
      headSha: "a".repeat(40),
      candidateGeneration: 1,
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview).toBeDefined();
    expect(overview!.blocked).toBe(true);
    expect(overview!.phase).toBe("in_review");
    expect(overview!.phaseSource).toBe("delivery");
    expect(overview!.project).toEqual({ id: projectId, name: "Delivery", color: "#123456" });
    expect(overview!.parent).toMatchObject({ id: parentId, title: "Parent", status: "in_progress" });
    expect(overview!.children.map((child) => child.status).sort()).toEqual(["cancelled", "done"]);
    expect(overview!.childCount).toBe(2);
    // A cancelled child is closed, not delivered.
    expect(overview!.completedChildCount).toBe(1);
    expect(overview!.blocker).toEqual({
      message: "Greptile raised one blocking finding",
      ownerLabel: "Security Reviewer",
      nextAction: "Address the review finding.",
      issues: [],
    });
    expect(overview!.delivery).toEqual({
      phase: "in_review",
      artifactReady: true,
      candidateGeneration: 1,
      readiness: "accepted",
      policy: null,
      reviewStatus: "changes_requested",
      blockingFindings: 1,
      queuePosition: null,
      nextAction: "Address the review finding.",
      lastEventAt: "2026-02-02T10:00:00.000Z",
      mergedAt: null,
    });
    expect(overview!.pullRequests).toEqual([
      {
        url: "https://github.com/acme/widget/pull/12",
        number: 12,
        repository: "acme/widget",
        state: "open",
        updatedAt: "2026-02-02T10:00:00.000Z",
        stale: true,
      },
    ]);
  });

  it("reports no recorded phase rather than a guessed lane", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({
      companyId,
      status: "blocked",
      identifier: "OV-2",
      unblockDescriptor: { owner: "board", action: "Approve the production deploy" },
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.phase).toBeNull();
    expect(overview!.phaseSource).toBe("unknown");
    expect(overview!.blocked).toBe(true);
    expect(overview!.blocker).toEqual({
      message: "Approve the production deploy",
      ownerLabel: "Board",
      nextAction: "Approve the production deploy",
      issues: [],
    });
    expect(overview!.delivery).toBeNull();
    expect(overview!.pullRequests).toEqual([]);
    expect(overview!.childCount).toBe(0);
    expect(overview!.children).toEqual([]);
  });

  it("keeps a blocked task in the phase it was blocked from", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "blocked", identifier: "OV-3" });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "in_progress", _previous: { status: "todo" } },
      createdAt: new Date("2026-02-01T10:00:00Z"),
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.phase).toBe("in_progress");
    expect(overview!.phaseSource).toBe("history");
    expect(overview!.blocked).toBe(true);
  });

  it("names the tasks that block it, ignoring resolved blockers", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "blocked", identifier: "OV-4" });
    const doneBlockerId = await createIssue({ companyId, status: "done", identifier: "OV-5", title: "Resolved" });
    const openBlockerId = await createIssue({ companyId, status: "todo", identifier: "OV-6", title: "Open" });
    await db.insert(issueRelations).values([
      { companyId, issueId: doneBlockerId, relatedIssueId: issueId, type: "blocks" },
      { companyId, issueId: openBlockerId, relatedIssueId: issueId, type: "blocks" },
    ]);

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.blocker!.issues.map((ref) => ref.identifier)).toEqual(["OV-6"]);
    expect(overview!.blocker!.message).toBe("Blocked by OV-6");
    expect(overview!.blocker!.nextAction).toBeNull();
  });

  it("gives a reopened task its later phase instead of the old merged delivery", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "blocked", identifier: "OV-7" });
    const repositoryId = await createRepository(companyId);
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "merged",
      prNumber: 7,
      prUrl: "https://github.com/acme/widget/pull/7",
      mergedAt: new Date("2026-01-01T10:00:00Z"),
      mergedSha: "b".repeat(40),
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "in_progress", _previous: { status: "done" } },
      createdAt: new Date("2026-02-01T10:00:00Z"),
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.phase).toBe("in_progress");
    expect(overview!.phaseSource).toBe("history");
    // The merged pull request stays visible as a fact about that pull request,
    // but the merge is history: no current delivery result is claimed.
    expect(overview!.delivery).toBeNull();
    expect(overview!.pullRequests.map((pr) => pr.state)).toEqual(["merged"]);
  });

  it("reports a merged delivery result while its cycle is the current one", async () => {
    const companyId = await createCompany();
    const doneId = await createIssue({ companyId, status: "done", identifier: "OV-20" });
    const blockedMergedId = await createIssue({ companyId, status: "blocked", identifier: "OV-21" });
    const repositoryId = await createRepository(companyId);
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: doneId,
      status: "merged",
      prNumber: 60,
      prUrl: "https://github.com/acme/widget/pull/60",
      mergedAt: new Date("2026-03-01T10:00:00Z"),
      mergedSha: "c".repeat(40),
      lastEventAt: new Date("2026-03-01T10:00:00Z"),
    });
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: blockedMergedId,
      status: "merged",
      prNumber: 61,
      prUrl: "https://github.com/acme/widget/pull/61",
      mergedAt: new Date("2026-03-02T10:00:00Z"),
      mergedSha: "d".repeat(40),
      lastEventAt: new Date("2026-03-02T10:00:00Z"),
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "delivery-controller",
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedMergedId,
      details: { status: "done", _previous: { status: "merging" } },
      createdAt: new Date("2026-03-02T10:00:00Z"),
    });

    const items = (await svc.list(companyId, [doneId, blockedMergedId])).items;
    const byId = new Map(items.map((item) => [item.issueId, item]));

    // The board's merge proof is a merged delivery phase plus a merge time on a
    // closed cycle — never a lone or refreshed pull request.
    expect(byId.get(doneId)!.delivery).toMatchObject({
      phase: "merged",
      mergedAt: "2026-03-01T10:00:00.000Z",
    });
    expect(byId.get(blockedMergedId)!.delivery).toMatchObject({
      phase: "merged",
      mergedAt: "2026-03-02T10:00:00.000Z",
    });
    expect(byId.get(blockedMergedId)!.phase).toBe("done");
    expect(byId.get(blockedMergedId)!.phaseSource).toBe("delivery");
  });

  it("covers every linked task, keeps multiple pull requests distinct, and never reads a cancellation as merged", async () => {
    const companyId = await createCompany();
    const primaryId = await createIssue({ companyId, status: "in_progress", identifier: "OV-8" });
    const coveredId = await createIssue({ companyId, status: "in_progress", identifier: "OV-9" });
    const closedId = await createIssue({ companyId, status: "in_progress", identifier: "OV-10" });
    const cancelledId = await createIssue({ companyId, status: "in_progress", identifier: "OV-11" });
    const repositoryId = await createRepository(companyId);
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: primaryId,
      coveredIssueIds: [coveredId],
      status: "in_review",
      prNumber: 20,
      prUrl: "https://github.com/acme/widget/pull/20",
      lastEventAt: new Date("2026-02-03T10:00:00Z"),
    });
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: primaryId,
      status: "closed_unmerged",
      prNumber: 21,
      prUrl: "https://github.com/acme/widget/pull/21",
      lastEventAt: new Date("2026-02-04T10:00:00Z"),
    });
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: closedId,
      status: "closed_unmerged",
      prNumber: 22,
      prUrl: "https://github.com/acme/widget/pull/22",
      lastEventAt: new Date("2026-02-04T10:00:00Z"),
    });
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: cancelledId,
      status: "cancelled",
      prNumber: 23,
      prUrl: "https://github.com/acme/widget/pull/23",
      lastEventAt: new Date("2026-02-04T10:00:00Z"),
    });

    const items = (await svc.list(companyId, [primaryId, coveredId, closedId, cancelledId])).items;
    const byId = new Map(items.map((item) => [item.issueId, item]));

    const primary = byId.get(primaryId)!;
    expect(primary.phase).toBe("in_progress");
    expect(primary.phaseSource).toBe("status");
    expect(primary.blocked).toBe(false);
    expect(primary.pullRequests.map((pr) => [pr.number, pr.state])).toEqual([[21, "closed"], [20, "open"]]);
    // One merged unit does not make this the current outcome, and the delivery
    // block reports the phase of the unit that is still open.
    expect(primary.delivery!.phase).toBe("in_review");
    expect(primary.delivery!.mergedAt).toBeNull();

    expect(byId.get(coveredId)!.pullRequests.map((pr) => pr.number)).toEqual([20]);
    expect(byId.get(closedId)!.pullRequests.map((pr) => [pr.number, pr.state])).toEqual([[22, "closed"]]);
    expect(byId.get(closedId)!.delivery!.mergedAt).toBeNull();
    // A cancelled unit is not a closed pull request; its state is unknown.
    expect(byId.get(cancelledId)!.pullRequests.map((pr) => [pr.number, pr.state])).toEqual([[23, "unknown"]]);
  });

  it("shows one chip when a provider observation and a delivery unit record the same pull request", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "done", identifier: "OV-30" });
    const repositoryId = await createRepository(companyId, "operator-fixtures", "never-publish", "example.test");
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "merged",
      prNumber: 43,
      prUrl: "https://example.test/operator-fixtures/never-publish/pull/43",
      mergedAt: new Date("2026-02-05T10:00:00Z"),
      mergedSha: "f".repeat(40),
      lastEventAt: new Date("2026-02-05T10:00:00Z"),
    });
    // The provider record names its repository the only way that writer does:
    // one `repository` string, with no split `owner`/`repo` pair to read.
    await createPullRequestObject({
      companyId,
      issueId,
      number: 43,
      statusKey: "merged",
      state: "closed",
      merged: true,
      repository: "operator-fixtures/never-publish",
      host: "example.test",
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    // Same URL, repository and number: one pull request, reported once, with the
    // provider observation reconciled into the delivery record's merge.
    expect(overview!.pullRequests).toEqual([
      {
        url: "https://example.test/operator-fixtures/never-publish/pull/43",
        number: 43,
        repository: "operator-fixtures/never-publish",
        state: "merged",
        updatedAt: "2026-02-05T10:00:00.000Z",
        stale: false,
      },
    ]);
    expect(overview!.delivery).toMatchObject({ phase: "merged", mergedAt: "2026-02-05T10:00:00.000Z" });
  });

  it("keeps the same repository and number on another host as a separate pull request", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "in_progress", identifier: "OV-31" });
    const repositoryId = await createRepository(companyId, "operator-fixtures", "never-publish", "example.test");
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "in_review",
      prNumber: 43,
      prUrl: "https://example.test/operator-fixtures/never-publish/pull/43",
      lastEventAt: new Date("2026-02-05T10:00:00Z"),
    });
    // A mirror forge reuses the owner, name and number for a different pull
    // request; joining on the host-blind repository name would collapse them.
    await createPullRequestObject({
      companyId,
      issueId,
      number: 43,
      statusKey: "open",
      owner: "operator-fixtures",
      repo: "never-publish",
      host: "mirror.test",
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.pullRequests.map((pr) => pr.url)).toEqual([
      "https://example.test/operator-fixtures/never-publish/pull/43",
      "https://mirror.test/operator-fixtures/never-publish/pull/43",
    ]);
  });

  it("never bridges two forges through a record that names no host", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "in_progress", identifier: "OV-32" });
    const repositoryId = await createRepository(companyId, "operator-fixtures", "never-publish", "example.test");
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "in_review",
      prNumber: 43,
      prUrl: "https://example.test/operator-fixtures/never-publish/pull/43",
      lastEventAt: new Date("2026-02-05T10:00:00Z"),
    });
    await createPullRequestObject({
      companyId,
      issueId,
      number: 43,
      statusKey: "open",
      owner: "operator-fixtures",
      repo: "never-publish",
      host: "mirror.test",
    });
    // A tracking link that names the repository and number but never a host. It
    // proves no shared identity, so it must not become the bridge that merges the
    // two forges — and it must stay visible on its own.
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "local",
      title: "Unresolved tracking link",
      externalId: "operator-fixtures/never-publish#43",
      url: null,
      status: "open",
      metadata: { number: 43 },
      updatedAt: new Date("2026-01-15T10:00:00Z"),
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.pullRequests.map((pr) => pr.url)).toEqual([
      "https://example.test/operator-fixtures/never-publish/pull/43",
      "https://mirror.test/operator-fixtures/never-publish/pull/43",
      null,
    ]);
    expect(overview!.pullRequests.map((pr) => pr.repository)).toEqual([
      "operator-fixtures/never-publish",
      "operator-fixtures/never-publish",
      "operator-fixtures/never-publish",
    ]);
  });

  it("reads canonical provider state for draft, closed-unmerged, open and merged pull requests", async () => {
    const companyId = await createCompany();
    const draftId = await createIssue({ companyId, status: "in_progress", identifier: "OV-12" });
    const closedId = await createIssue({ companyId, status: "in_progress", identifier: "OV-13" });
    const openId = await createIssue({ companyId, status: "in_progress", identifier: "OV-14" });
    const mergedId = await createIssue({ companyId, status: "done", identifier: "OV-15" });
    await createPullRequestObject({ companyId, issueId: draftId, number: 30, statusKey: "draft", state: "open", draft: true });
    await createPullRequestObject({ companyId, issueId: closedId, number: 31, statusKey: "closed", state: "closed" });
    await createPullRequestObject({ companyId, issueId: openId, number: 32, statusKey: "open", state: "open" });
    await createPullRequestObject({
      companyId,
      issueId: mergedId,
      number: 33,
      statusKey: "merged",
      state: "closed",
      merged: true,
    });

    const items = (await svc.list(companyId, [draftId, closedId, openId, mergedId])).items;
    const byId = new Map(items.map((item) => [item.issueId, item]));

    expect(byId.get(draftId)!.pullRequests[0]).toMatchObject({ state: "draft", number: 30, repository: "acme/widget" });
    expect(byId.get(closedId)!.pullRequests[0]).toMatchObject({ state: "closed", number: 31 });
    expect(byId.get(openId)!.pullRequests[0]).toMatchObject({ state: "open", number: 32 });
    expect(byId.get(mergedId)!.pullRequests[0]).toMatchObject({ state: "merged", number: 33 });
    // Status `done` alone is not merge proof: the fact comes from the provider
    // observation, and the delivery record is what proves a merge.
    expect(byId.get(mergedId)!.delivery).toBeNull();
  });

  it("keeps a stale provider read distinct from having no pull request", async () => {
    const companyId = await createCompany();
    const unknownId = await createIssue({ companyId, status: "in_progress", identifier: "OV-16" });
    const noneId = await createIssue({ companyId, status: "in_progress", identifier: "OV-17" });
    await createPullRequestObject({
      companyId,
      issueId: unknownId,
      number: 40,
      statusKey: "open",
      state: "open",
      liveness: "unreachable",
      nextRefreshAt: null,
    });

    const items = (await svc.list(companyId, [unknownId, noneId])).items;
    const byId = new Map(items.map((item) => [item.issueId, item]));

    // A stale read keeps the last known state and is marked stale; it is never
    // reported as "no pull request".
    expect(byId.get(unknownId)!.pullRequests[0]).toMatchObject({ state: "open", stale: true });
    expect(byId.get(noneId)!.pullRequests).toEqual([]);
  });

  it("does not verify an old merge after the task was reopened and closed again", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "done", identifier: "OV-22" });
    const repositoryId = await createRepository(companyId);
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "merged",
      prNumber: 70,
      prUrl: "https://github.com/acme/widget/pull/70",
      mergedAt: new Date("2026-01-01T10:00:00Z"),
      mergedSha: "e".repeat(40),
      lastEventAt: new Date("2026-01-01T10:00:00Z"),
    });
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "in_progress", _previous: { status: "done" } },
        createdAt: new Date("2026-02-01T10:00:00Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "done", _previous: { status: "in_progress" } },
        createdAt: new Date("2026-02-02T10:00:00Z"),
      },
    ]);

    const [overview] = (await svc.list(companyId, [issueId])).items;

    // The old unit merged before the reopen. A second `done` must not turn that
    // historical merge into the current outcome.
    expect(overview!.delivery).toBeNull();
    expect(overview!.phase).toBe("done");
    expect(overview!.phaseSource).toBe("status");
    // The pull request itself is still reported as merged.
    expect(overview!.pullRequests.map((pr) => pr.state)).toEqual(["merged"]);
  });

  it("uses delivery-blocked evidence and named blockers when the status is not blocked", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "in_progress", identifier: "OV-23" });
    const blockerId = await createIssue({ companyId, status: "todo", identifier: "OV-24" });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const repositoryId = await createRepository(companyId);
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "blocked",
      prNumber: 80,
      prUrl: "https://github.com/acme/widget/pull/80",
      blocker: {
        reasonCode: "checks_failing",
        message: "Required checks are failing",
        owner: null,
        nextAction: "Fix the failing check.",
      },
      metadata: { blockedPhase: "in_review" },
      lastEventAt: new Date("2026-02-03T10:00:00Z"),
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.blocked).toBe(true);
    expect(overview!.phase).toBe("in_review");
    expect(overview!.phaseSource).toBe("delivery");
    expect(overview!.blocker!.issues.map((ref) => ref.identifier)).toEqual(["OV-24"]);
    // The named task is the current cause; the unit's unrelated check action
    // must not be presented as the action for that task dependency.
    expect(overview!.blocker!.ownerLabel).toBeNull();
    expect(overview!.blocker!.nextAction).toBeNull();
  });

  it("caps children per parent so a large subtree cannot starve a later parent", async () => {
    const companyId = await createCompany();
    const firstParentId = await createIssue({ companyId, status: "in_progress", identifier: "OV-25" });
    const secondParentId = await createIssue({ companyId, status: "in_progress", identifier: "OV-26" });
    const base = Date.parse("2026-01-01T00:00:00Z");
    await db.insert(issues).values([
      ...Array.from({ length: MAX_CHILD_REFS_PER_ISSUE + 12 }, (_value, index) => ({
        id: randomUUID(),
        companyId,
        parentId: firstParentId,
        title: `First parent child ${index}`,
        status: "todo",
        createdAt: new Date(base + index * 1000),
      })),
      {
        id: randomUUID(),
        companyId,
        parentId: secondParentId,
        title: "Second parent child",
        status: "done",
        createdAt: new Date(base + 10_000_000),
      },
    ]);

    const items = (await svc.list(companyId, [firstParentId, secondParentId])).items;
    const byId = new Map(items.map((item) => [item.issueId, item]));

    expect(byId.get(firstParentId)!.children).toHaveLength(MAX_CHILD_REFS_PER_ISSUE);
    expect(byId.get(firstParentId)!.childCount).toBe(MAX_CHILD_REFS_PER_ISSUE + 12);
    // The second parent is still represented; a global row cap would have eaten it.
    expect(byId.get(secondParentId)!.children).toHaveLength(1);
    expect(byId.get(secondParentId)!.childCount).toBe(1);
    expect(byId.get(secondParentId)!.completedChildCount).toBe(1);
  });

  it("never releases a non-http pull-request link to the board", async () => {
    const companyId = await createCompany();
    const unsafeId = await createIssue({ companyId, status: "in_progress", identifier: "OV-27" });
    const safeId = await createIssue({ companyId, status: "in_progress", identifier: "OV-28" });
    const repositoryId = await createRepository(companyId);
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: unsafeId,
      status: "in_review",
      prNumber: 90,
      prUrl: "javascript:alert(1)",
    });
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: safeId,
      status: "in_review",
      prNumber: 91,
      prUrl: "https://github.com/acme/widget/pull/91",
    });

    const items = (await svc.list(companyId, [unsafeId, safeId])).items;
    const byId = new Map(items.map((item) => [item.issueId, item]));

    expect(byId.get(unsafeId)!.pullRequests[0]!.url).toBeNull();
    expect(byId.get(safeId)!.pullRequests[0]!.url).toBe("https://github.com/acme/widget/pull/91");
  });

  it("never names a user who is not a member of this company", async () => {
    const companyId = await createCompany();
    const otherCompanyId = await createCompany();
    const outsiderId = randomUUID();
    await db.insert(authUsers).values({
      id: outsiderId,
      name: "Outside Operator",
      email: `${outsiderId}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: otherCompanyId,
      principalType: "user",
      principalId: outsiderId,
      status: "active",
      membershipRole: "owner",
    });
    const issueId = await createIssue({
      companyId,
      status: "blocked",
      identifier: "OV-29",
      unblockDescriptor: { owner: { userId: outsiderId }, action: "Grant repository access" },
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;

    expect(overview!.blocker!.ownerLabel).toBe("User");
    expect(JSON.stringify(overview)).not.toContain("Outside Operator");
  });

  it("ranks queue positions with the delivery queue's own ordering and partitions", async () => {
    const companyId = await createCompany();
    const repositoryId = await createRepository(companyId);
    const otherRepositoryId = await createRepository(companyId, "acme", "gadget");
    // Priorities chosen so rank order differs from insertion order, plus one
    // unrecognized priority that must fall back to `medium` exactly as
    // `deliveryPriorityRank` does.
    const plans: Array<{ priority: string; branch: string; repositoryId: string }> = [
      { priority: "low", branch: "main", repositoryId },
      { priority: "critical", branch: "main", repositoryId },
      { priority: "urgent", branch: "main", repositoryId },
      { priority: "high", branch: "main", repositoryId },
      { priority: "critical", branch: "release", repositoryId },
      { priority: "critical", branch: "main", repositoryId: otherRepositoryId },
    ];
    const unitIds: string[] = [];
    const issueIds: string[] = [];
    for (const [index, plan] of plans.entries()) {
      const issueId = await createIssue({ companyId, status: "in_progress", identifier: `OV-Q${index}` });
      issueIds.push(issueId);
      const unitId = await createUnit({
        companyId,
        repositoryId: plan.repositoryId,
        primaryIssueId: issueId,
        status: "ready_to_merge",
        targetBranch: plan.branch,
        prNumber: 100 + index,
        prUrl: `https://github.com/acme/widget/pull/${100 + index}`,
      });
      unitIds.push(unitId);
      await db.insert(deliveryQueueEntries).values({
        companyId,
        repositoryId: plan.repositoryId,
        targetBranch: plan.branch,
        unitId,
        status: "queued",
        priority: plan.priority,
        // Equal readiness, so order falls through to priority then id.
        readyAt: new Date("2026-02-01T10:00:00Z"),
        enqueuedAt: new Date("2026-02-01T10:00:00Z"),
      });
    }

    const items = (await svc.list(companyId, issueIds)).items;
    const rankByUnitIssue = new Map(items.map((item) => [item.issueId, item.delivery!.queuePosition]));

    // Independent expectation: partition, then the shared queue comparator.
    const expectedPosition = (index: number) => {
      const target = plans[index]!;
      const group = plans
        .map((plan, planIndex) => ({ plan, planIndex }))
        .filter((entry) => entry.plan.repositoryId === target.repositoryId && entry.plan.branch === target.branch);
      group.sort((left, right) =>
        deliveryPriorityRank(left.plan.priority) - deliveryPriorityRank(right.plan.priority)
        || unitIds[left.planIndex]!.localeCompare(unitIds[right.planIndex]!));
      return group.findIndex((entry) => entry.planIndex === index) + 1;
    };

    plans.forEach((_plan, index) => {
      expect(rankByUnitIssue.get(issueIds[index]!)).toBe(expectedPosition(index));
    });
    // Pinned absolute positions on one branch: critical, high, unknown-priority
    // (medium), low — not the insertion order.
    expect(rankByUnitIssue.get(issueIds[1]!)).toBe(1);
    expect(rankByUnitIssue.get(issueIds[3]!)).toBe(2);
    expect(rankByUnitIssue.get(issueIds[2]!)).toBe(3);
    expect(rankByUnitIssue.get(issueIds[0]!)).toBe(4);
    // The same priority in another branch or repository is a separate queue.
    expect(rankByUnitIssue.get(issueIds[4]!)).toBe(1);
    expect(rankByUnitIssue.get(issueIds[5]!)).toBe(1);
  });

  it("places a queued unit in its repository queue and stays company scoped", async () => {
    const companyId = await createCompany();
    const otherCompanyId = await createCompany();
    const issueId = await createIssue({ companyId, status: "in_progress", identifier: "OV-18" });
    const leaderIssueId = await createIssue({ companyId, status: "in_progress", identifier: "OV-19" });
    const repositoryId = await createRepository(companyId);
    const leaderUnitId = await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: leaderIssueId,
      status: "ready_to_merge",
      prNumber: 50,
      prUrl: "https://github.com/acme/widget/pull/50",
    });
    const unitId = await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "ready_to_merge",
      prNumber: 51,
      prUrl: "https://github.com/acme/widget/pull/51",
    });
    await db.insert(deliveryQueueEntries).values([
      {
        companyId,
        repositoryId,
        targetBranch: "main",
        unitId,
        status: "queued",
        priority: "medium",
        readyAt: new Date("2026-02-01T10:00:00Z"),
        enqueuedAt: new Date("2026-02-01T10:00:00Z"),
      },
      {
        companyId,
        repositoryId,
        targetBranch: "main",
        unitId: leaderUnitId,
        status: "queued",
        priority: "high",
        readyAt: new Date("2026-02-01T09:00:00Z"),
        enqueuedAt: new Date("2026-02-01T09:00:00Z"),
      },
    ]);

    const [overview] = (await svc.list(companyId, [issueId])).items;
    expect(overview!.delivery!.queuePosition).toBe(2);

    // The same ids under another company reveal nothing.
    expect((await svc.list(otherCompanyId, [issueId])).items).toEqual([]);
    expect((await svc.list(companyId, [randomUUID(), issueId])).items).toHaveLength(1);
  });

  it("shows a superseded candidate's evidence as history, never as the current review", async () => {
    const companyId = await createCompany();
    const projectId = await createProject(companyId, "Delivery");
    const issueId = await createIssue({ companyId, status: "in_review", projectId });
    const repositoryId = await createRepository(companyId);
    const oldHead = "b".repeat(40);
    const currentHead = "c".repeat(40);
    // The unit is on its second candidate, but the cached display evidence and
    // the open finding still belong to the first one.
    const unitId = await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "in_review",
      projectId,
      prNumber: 31,
      prUrl: "https://github.com/acme/widget/pull/31",
      candidateGeneration: 2,
      headSha: currentHead,
      metadata: {
        evidenceGeneration: 1,
        checksHeadSha: oldHead,
        reviewStatus: "approved",
        reviewHeadSha: oldHead,
        blockingFindings: 3,
      },
      lastEventAt: new Date("2026-03-01T10:00:00Z"),
    });
    await db.insert(deliveryFindings).values({
      companyId,
      unitId,
      externalId: "old-finding",
      title: "Raised against the first candidate",
      severity: "high",
      state: "open",
      headSha: oldHead,
      candidateGeneration: 1,
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;
    const delivery = overview!.delivery!;
    expect(delivery.candidateGeneration).toBe(2);
    // Not a cached pass, not the old head's findings: unknown until fresh
    // evidence for generation 2 is read.
    expect(delivery.reviewStatus).toBe("unknown");
    expect(delivery.blockingFindings).toBe(0);
    expect(delivery.readiness).toBe("unknown");
    expect(delivery.artifactReady).toBe(false);
  });

  it("reads a failed authoritative read of the current candidate as unknown rather than a pass", async () => {
    const companyId = await createCompany();
    const projectId = await createProject(companyId, "Delivery");
    const issueId = await createIssue({ companyId, status: "in_review", projectId });
    const repositoryId = await createRepository(companyId);
    const head = "d".repeat(40);
    await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "blocked",
      projectId,
      prNumber: 32,
      prUrl: "https://github.com/acme/widget/pull/32",
      candidateGeneration: 1,
      headSha: head,
      blocker: {
        reasonCode: "provider_unknown",
        message: "Checks could not be read from GitHub for the current head",
        owner: null,
        nextAction: "Reconcile again once GitHub is reachable.",
      },
      metadata: {
        evidenceGeneration: 1,
        lastReadFailed: true,
        checksHeadSha: head,
        reviewStatus: "approved",
        reviewHeadSha: head,
        blockingFindings: 0,
      },
      lastEventAt: new Date("2026-03-02T10:00:00Z"),
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;
    expect(overview!.delivery).toMatchObject({
      reviewStatus: "unknown",
      readiness: "unknown",
      blockingFindings: 0,
    });
    // The current blocker is the controller's failed read, and it names the
    // owner/action the board must act on.
    expect(overview!.blocker).toMatchObject({
      message: "Checks could not be read from GitHub for the current head",
      nextAction: "Reconcile again once GitHub is reachable.",
    });
  });

  it("lets the current unit blocker supersede a historical unblock descriptor", async () => {
    const companyId = await createCompany();
    const projectId = await createProject(companyId, "Delivery");
    // The descriptor was written before the unit existed and names an old
    // concern; the unit now records the authoritative blocker.
    const issueId = await createIssue({
      companyId,
      status: "in_review",
      projectId,
      unblockDescriptor: {
        action: "Resolve the old Greptile comment on the previous revision.",
        owner: "board",
      },
    });
    const repositoryId = await createRepository(companyId);
    const unitId = await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "blocked",
      projectId,
      prNumber: 33,
      prUrl: "https://github.com/acme/widget/pull/33",
      candidateGeneration: 1,
      headSha: "e".repeat(40),
      blocker: {
        reasonCode: "deployment_authority_missing",
        message: "Policy authorization was voided by a material scope change (targetBranch); the changed scope is not authorized",
        owner: "Operator",
        nextAction: "Re-authorize the delivery policy scope before this candidate can merge.",
      },
      metadata: { blockedPhase: "in_review", evidenceGeneration: 1 },
      lastEventAt: new Date("2026-03-03T10:00:00Z"),
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;
    expect(overview!.blocked).toBe(true);
    expect(overview!.blocker).toEqual({
      message: "Policy authorization was voided by a material scope change (targetBranch); the changed scope is not authorized",
      ownerLabel: "Operator",
      nextAction: "Re-authorize the delivery policy scope before this candidate can merge.",
      issues: [],
    });

    await db.update(deliveryUnits).set({
      blocker: {
        reasonCode: "provider_unknown",
        message: "The current provider response does not identify an actionable owner.",
        owner: null,
        nextAction: null,
      },
    }).where(eq(deliveryUnits.id, unitId));
    const [unowned] = (await svc.list(companyId, [issueId])).items;
    expect(unowned!.blocker).toEqual({
      message: "The current provider response does not identify an actionable owner.",
      ownerLabel: null,
      nextAction: null,
      issues: [],
    });
  });

  it("projects the standing policy's authority state and keeps readiness separate from it", async () => {
    const companyId = await createCompany();
    const projectId = await createProject(companyId, "Delivery");
    const issueId = await createIssue({ companyId, status: "in_review", projectId });
    const repositoryId = await createRepository(companyId);
    const head = "f".repeat(40);
    await db.insert(deliveryPolicies).values({
      companyId,
      projectId,
      repositoryId,
      targetBranch: "main",
      enabled: true,
      autoDeployDisposition: "no_auto_deploy",
      authorization: null,
      authorizationInvalidatedAt: new Date("2026-03-04T00:00:00Z"),
      authorizationInvalidatedScope: ["targetBranch"],
    });
    const unitId = await createUnit({
      companyId,
      repositoryId,
      primaryIssueId: issueId,
      status: "ready_to_merge",
      projectId,
      prNumber: 34,
      prUrl: "https://github.com/acme/widget/pull/34",
      candidateGeneration: 1,
      headSha: head,
      acceptedHeadSha: head,
      metadata: { evidenceGeneration: 1, reviewStatus: "approved", reviewHeadSha: head, checksHeadSha: head },
      lastEventAt: new Date("2026-03-04T10:00:00Z"),
    });

    const [overview] = (await svc.list(companyId, [issueId])).items;
    // Readiness is the evidence fact; authority is the policy fact, and the
    // board shows both instead of collapsing them.
    expect(overview!.delivery).toMatchObject({
      readiness: "accepted",
      policy: {
        authorizationState: "invalidated",
        authorizationInvalidatedScope: ["targetBranch"],
        autoDeployDisposition: "no_auto_deploy",
      },
    });

    // A policy that was never authorized reads as `missing`, not `invalidated`.
    await db
      .update(deliveryPolicies)
      .set({ authorizationInvalidatedAt: null, authorizationInvalidatedScope: null })
      .where(eq(deliveryPolicies.projectId, projectId));
    const [unrecorded] = (await svc.list(companyId, [issueId])).items;
    expect(unrecorded!.delivery).toMatchObject({
      readiness: "accepted",
      policy: { authorizationState: "missing", authorizationInvalidatedScope: [] },
    });
    expect(unitId).toBeTruthy();
  });
});
