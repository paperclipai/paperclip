import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { createIssueRoutesTestDeps } from "./helpers/issue-routes-test-deps.js";

type TestBoardActor = {
  type: "board";
  userId: string;
  companyIds: string[];
  source: string;
  isInstanceAdmin: boolean;
};

const testBoardActor: TestBoardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const childIssueId = "11111111-1111-4111-8111-111111111111";
const parentIssueId = "22222222-2222-4222-8222-222222222222";
const executorAgentId = "33333333-3333-4333-8333-333333333333";
const reviewerAgentId = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  list: vi.fn(),
  listComments: vi.fn(),
  findMentionedAgents: vi.fn(),
  checkout: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listVotesForIssue: vi.fn(async () => []),
  upsertVote: vi.fn(async () => undefined),
  removeVote: vi.fn(async () => undefined),
  queueTrace: vi.fn(async () => undefined),
  listTracesForIssue: vi.fn(async () => []),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));
const mockReviewDispatch = vi.hoisted(() => ({
  dispatchForIssue: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/review-dispatch.js", () => ({
  REVIEW_DISPATCH_ORIGIN_KIND: "technical_review_dispatch",
  reviewDispatchService: () => mockReviewDispatch,
}));

function createApp() {
  const { db, storage } = createIssueRoutesTestDeps();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { actor: TestBoardActor }).actor = testBoardActor;
    next();
  });
  app.use("/api", issueRoutes(db, storage));
  app.use(errorHandler);
  return app;
}

function makeReviewIssue(status: string) {
  return {
    id: childIssueId,
    companyId: "company-1",
    status,
    assigneeAgentId: reviewerAgentId,
    assigneeUserId: null,
    createdByUserId: null,
    identifier: "PAP-701",
    title: "Review issue",
    parentId: parentIssueId,
    originKind: "technical_review_dispatch",
  };
}

function makeManualReviewIssue(status: string) {
  return {
    ...makeReviewIssue(status),
    originKind: "manual",
    title: "Revisar PR #999 de PAP-700",
  };
}

function makeParentIssue(status: string) {
  return {
    id: parentIssueId,
    companyId: "company-1",
    status,
    assigneeAgentId: executorAgentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-700",
    title: "Source issue",
    originKind: "manual",
    parentId: null,
  };
}

function makePrimaryPullRequestProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "wp-1",
    issueId: parentIssueId,
    companyId: "company-1",
    projectId: null,
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: "218",
    title: "PR #218",
    url: "https://github.com/acme/app/pull/218",
    status: "ready_for_review",
    reviewState: "approved",
    isPrimary: true,
    healthStatus: "healthy",
    summary: null,
    metadata: {},
    createdByRunId: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:05:00.000Z"),
    ...overrides,
  };
}

describe("issue review outcome reconciliation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.listComments.mockReset();
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: childIssueId,
      companyId: "company-1",
      body: "review summary",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    mockReviewDispatch.dispatchForIssue.mockResolvedValue({
      kind: "noop",
      reason: "pull_request_not_found",
    });
  });

  it("re-attempts technical review dispatch when parent is already technical_review", async () => {
    const parent = makeParentIssue("technical_review");
    mockIssueService.getById.mockResolvedValue(parent);

    mockReviewDispatch.dispatchForIssue.mockResolvedValueOnce({
      kind: "created",
      reviewIssue: {
        id: "review-1",
        companyId: "company-1",
        identifier: "PAP-702",
        title: "Review PR #218",
        originKind: "technical_review_dispatch",
        originId: parent.id,
        assigneeAgentId: reviewerAgentId,
      },
      artifact: {
        pullRequest: {
          url: "https://github.com/acme/app/pull/218",
          prNumber: 218,
        },
        diffIdentity: "github:acme/app:pr:218",
      },
    });

    const res = await request(createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({ comment: "Revalidar dispatch técnico com PR já vinculado." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockReviewDispatch.dispatchForIssue).toHaveBeenCalledWith({
      issueId: parentIssueId,
      commentId: "comment-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_dispatch_created",
        entityId: parentIssueId,
      }),
    );
  });

  it("returns the parent issue to in_progress when the technical review has blocking findings", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update.mockResolvedValueOnce(updatedChild);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-parent-1" });
    mockIssueService.checkout.mockResolvedValue({
      ...parent,
      status: "in_progress",
      checkoutRunId: "run-parent-1",
      executionRunId: "run-parent-1",
    });

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica concluida

### Findings bloqueantes
1. Regressao importante no fluxo.

### Decisao operacional
- Retornar [PAP-700](/PAP/issues/PAP-700) para \`in_progress\` ate corrigir o finding bloqueante.`,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      executorAgentId,
      expect.objectContaining({
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: parentIssueId,
          reviewIssueId: childIssueId,
          mutation: "review_blocking_findings",
        }),
      }),
    );
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      parentIssueId,
      executorAgentId,
      ["handoff_ready"],
      "run-parent-1",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_outcome_reconciled",
        entityId: parentIssueId,
        details: expect.objectContaining({
          outcome: "blocking",
          reviewIssueId: childIssueId,
          resumedRunId: "run-parent-1",
        }),
      }),
    );
  });

  it("advances the parent issue to human_review when the technical review has no blocking findings", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" })
      .mockResolvedValueOnce({ ...parent, status: "human_review" });

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica concluida

### Findings bloqueantes
- Nenhum.

### Decisao operacional
- [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final/merge.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([
      [childIssueId, { status: "done" }],
      [parentIssueId, { status: "technical_review" }],
      [parentIssueId, { status: "human_review" }],
    ]);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_outcome_reconciled",
        entityId: parentIssueId,
        details: expect.objectContaining({
          outcome: "approved",
          reviewIssueId: childIssueId,
          transitions: [
            "handoff_ready->technical_review",
            "technical_review->human_review",
          ],
          mergeDelegateWakeupEnqueued: false,
        }),
      }),
    );
  });

  it("wakes the executor when review approves and the PR work product has directMergeEligible metadata", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" })
      .mockResolvedValueOnce({ ...parent, status: "human_review" });
    mockWorkProductService.listForIssue.mockResolvedValue([
      makePrimaryPullRequestProduct({
        metadata: { directMergeEligible: true, prNumber: 218 },
      }),
    ]);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica concluida

### Findings bloqueantes
- Nenhum.

### Decisao operacional
- [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final/merge.`,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      executorAgentId,
      expect.objectContaining({
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: parentIssueId,
          reviewIssueId: childIssueId,
          mutation: "review_approved_merge_delegate",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: parentIssueId,
          taskId: parentIssueId,
          source: "issue.review_outcome",
          reviewOutcome: "approved",
          pullRequestUrl: "https://github.com/acme/app/pull/218",
          pullRequestNumber: 218,
          workProductId: "wp-1",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_outcome_reconciled",
        entityId: parentIssueId,
        details: expect.objectContaining({
          outcome: "approved",
          mergeDelegateWakeupEnqueued: true,
        }),
      }),
    );
  });

  it("does not wake the executor for direct merge when the PR is still draft even if metadata requests it", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" });
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        ...makePrimaryPullRequestProduct({
          id: "wp-draft-1",
          externalId: "321",
          url: "https://github.com/acme/app/pull/321",
          status: "draft",
          metadata: { draft: true, directMergeEligible: true },
        }),
      },
    ]);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica concluida

### Findings bloqueantes
- Nenhum.

### Decisao operacional
- [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final/merge.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_outcome_reconciled",
        entityId: parentIssueId,
        details: expect.objectContaining({
          mergeDelegateWakeupEnqueued: false,
          deferredHumanReviewBecausePullRequestDraft: true,
        }),
      }),
    );
  });

  it("reconciles from the latest review comment when the child is closed without an inline patch comment", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" })
      .mockResolvedValueOnce({ ...parent, status: "human_review" });
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "review-comment-1",
        issueId: childIssueId,
        companyId: "company-1",
        body: `## Revisao tecnica concluida

### Findings bloqueantes
- Nenhum.

### Decisao operacional
- [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final/merge.`,
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: reviewerAgentId,
        authorUserId: null,
      },
    ]);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith(childIssueId, {
      order: "desc",
      limit: 10,
    });
    expect(mockIssueService.update.mock.calls).toEqual([
      [childIssueId, { status: "done" }],
      [parentIssueId, { status: "technical_review" }],
      [parentIssueId, { status: "human_review" }],
    ]);
  });

  it("reconciles a manual review child when it clearly matches the review-ticket pattern", async () => {
    const existingChild = makeManualReviewIssue("technical_review");
    const updatedChild = makeManualReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" })
      .mockResolvedValueOnce({ ...parent, status: "human_review" });

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Resumo de revisão técnica

- Blocking findings: nenhum
- Non-blocking findings: nenhum
- Decisão operacional: [PAP-700](/PAP/issues/PAP-700) pode seguir para revisão humana final (nenhum finding aberto).`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([
      [childIssueId, { status: "done" }],
      [parentIssueId, { status: "technical_review" }],
      [parentIssueId, { status: "human_review" }],
    ]);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_outcome_reconciled",
        entityId: parentIssueId,
        details: expect.objectContaining({
          outcome: "approved",
          reviewIssueId: childIssueId,
        }),
      }),
    );
  });

  it("stops at technical_review when the linked pull request is still draft", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" });
    mockWorkProductService.listForIssue.mockResolvedValue([
      makePrimaryPullRequestProduct({
        id: "wp-draft-1",
        externalId: "321",
        url: "https://github.com/acme/app/pull/321",
        title: "PR #321",
        status: "draft",
        reviewState: "none",
        metadata: { draft: true },
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:05:00.000Z"),
      }),
    ]);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica concluida

### Findings bloqueantes
- Nenhum.

### Decisao operacional
- [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final/merge.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([
      [childIssueId, { status: "done" }],
      [parentIssueId, { status: "technical_review" }],
    ]);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_outcome_reconciled",
        entityId: parentIssueId,
        details: expect.objectContaining({
          outcome: "approved",
          transitions: ["handoff_ready->technical_review"],
          deferredHumanReviewBecausePullRequestDraft: true,
          pullRequestProductId: "wp-draft-1",
          pullRequestStatus: "draft",
          mergeDelegateWakeupEnqueued: false,
        }),
      }),
    );
  });

  it("treats all-caps findings heading and English none as approved", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" })
      .mockResolvedValueOnce({ ...parent, status: "human_review" });

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica

### FINDINGS BLOQUEANTES
- None.

### Decisao operacional
- PR pronto para revisao humana.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([
      [childIssueId, { status: "done" }],
      [parentIssueId, { status: "technical_review" }],
      [parentIssueId, { status: "human_review" }],
    ]);
  });

  it("detects blocking findings when heading uses '### Blocking (N)' format", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update.mockResolvedValueOnce(updatedChild);
    mockIssueService.checkout.mockResolvedValue({ ...parent, status: "in_progress" });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-123" });

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisão Técnica Concluída — Round 1

### Blocking (1)
- **Frontend caller não envia X-API-Key** — \`propertySearchService.ts\` não passa o header obrigatório.

### Non-blocking (2)
- Minor style issue.
- Missing test edge case.`,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalled();
    expect(mockIssueService.checkout).toHaveBeenCalled();
  });

  it("detects approved when heading uses '### Blocking (N)' with 'Nenhum'", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update
      .mockResolvedValueOnce(updatedChild)
      .mockResolvedValueOnce({ ...parent, status: "technical_review" })
      .mockResolvedValueOnce({ ...parent, status: "human_review" });

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisão Técnica — Round 1

### Blocking findings
Nenhum.

### Non-blocking findings
Nenhum.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([
      [childIssueId, { status: "done" }],
      [parentIssueId, { status: "technical_review" }],
      [parentIssueId, { status: "human_review" }],
    ]);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("test_blocking_review_malformed_summary: vague closing comment does not move parent; emits unparsed activity", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update.mockResolvedValueOnce(updatedChild);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: "Looks good! Ship it.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([[childIssueId, { status: "done" }]]);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_outcome_unparsed",
        entityId: childIssueId,
        details: expect.objectContaining({
          parentIssueId,
          reason: "no_classified_outcome",
        }),
      }),
    );
    expect(
      mockLogActivity.mock.calls.some(
        (c) => c[1]?.action === "issue.review_outcome_reconciled",
      ),
    ).toBe(false);
  });

  it("test_nonblocking_review_missing_format_markers: PT summary without markers or approval phrases is unparsed", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update.mockResolvedValueOnce(updatedChild);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica concluida
Sem findings bloqueantes nesta rodada.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([[childIssueId, { status: "done" }]]);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.review_outcome_unparsed", entityId: childIssueId }),
    );
  });

  it("test_review_ambiguous_phrases: conflicting signals yield no parent transition", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parent = makeParentIssue("handoff_ready");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parent);
    mockIssueService.update.mockResolvedValueOnce(updatedChild);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `### Findings bloqueantes
1. Bug critico.

Pode seguir para revisao humana.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([[childIssueId, { status: "done" }]]);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.review_outcome_unparsed", entityId: childIssueId }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("test_parent_in_unexpected_state: parent already done skips reconciliation without unparsed when comment is valid", async () => {
    const existingChild = makeReviewIssue("technical_review");
    const updatedChild = makeReviewIssue("done");
    const parentDone = makeParentIssue("done");

    mockIssueService.getById
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValueOnce(parentDone);
    mockIssueService.update.mockResolvedValueOnce(updatedChild);

    const res = await request(createApp())
      .patch(`/api/issues/${childIssueId}`)
      .send({
        status: "done",
        comment: `## Revisao tecnica concluida

### Findings bloqueantes
- Nenhum.

### Decisao operacional
- [PAP-700](/PAP/issues/PAP-700) pode seguir para revisao humana final/merge.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls).toEqual([[childIssueId, { status: "done" }]]);
    expect(
      mockLogActivity.mock.calls.some(
        (c) => c[1]?.action === "issue.review_outcome_unparsed",
      ),
    ).toBe(false);
    expect(
      mockLogActivity.mock.calls.some(
        (c) => c[1]?.action === "issue.review_outcome_reconciled",
      ),
    ).toBe(false);
  });
});
