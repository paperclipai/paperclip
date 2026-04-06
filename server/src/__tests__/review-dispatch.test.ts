import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { reviewDispatchService, REVIEW_DISPATCH_ORIGIN_KIND } from "../services/review-dispatch.ts";

type ServiceDeps = Parameters<typeof reviewDispatchService>[1];

const testDb = {} as Db;

function createMockDeps(overrides?: Partial<ServiceDeps>): ServiceDeps {
  return {
    agents: {
      resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: false as const })),
    },
    issues: {
      getById: vi.fn(async () => null),
      getComment: vi.fn(async () => null),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => []),
      create: vi.fn(),
    },
    workProducts: {
      listForIssue: vi.fn(async () => []),
    },
    companies: {
      getById: vi.fn(async () => null),
    },
    ...overrides,
  } as ServiceDeps;
}

function makeIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-1",
    goalId: "goal-1",
    parentId: null,
    title: "Source issue",
    description: "Source issue description",
    status: "handoff_ready",
    priority: "high",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    billingCode: null,
    executionWorkspaceId: "exec-1",
    identifier: "TCN-15",
    originKind: "manual",
    originId: null,
    createdAt: new Date("2026-03-29T21:25:00.000Z"),
    updatedAt: new Date("2026-03-29T21:25:00.000Z"),
    ...overrides,
  };
}

function makeComment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "comment-1",
    issueId: "issue-1",
    companyId: "company-1",
    body: "## Handoff\n\nPR: https://github.com/acme/app/pull/212",
    createdAt: new Date("2026-03-29T21:25:15.000Z"),
    updatedAt: new Date("2026-03-29T21:25:15.000Z"),
    authorAgentId: "agent-1",
    authorUserId: null,
    ...overrides,
  };
}

function makeReviewIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return makeIssue({
    id: "review-1",
    identifier: "TCN-59",
    title: "Revisar PR #212 de TCN-15",
    description: "## Links\n\n- PR atual: https://github.com/acme/app/pull/212",
    assigneeAgentId: "reviewer-1",
    parentId: "issue-1",
    status: "todo",
    createdAt: new Date("2026-03-29T21:47:05.000Z"),
    ...overrides,
  });
}

describe("reviewDispatchService", () => {
  it("creates a technical review subtask from the latest handoff comment", async () => {
    const createdReviewIssue = makeReviewIssue({
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-1",
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => makeComment()),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => []),
      create: vi.fn(async () => createdReviewIssue),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => []),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1", commentId: "comment-1" });

    expect(result.kind).toBe("created");
    expect(issues.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      title: "Revisar PR #212 de TCN-15",
      assigneeAgentId: "reviewer-1",
      parentId: "issue-1",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-1",
    }));
    expect(issues.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      description: expect.stringContaining("[TCN-15](/TCN/issues/TCN-15)"),
    }));
    expect(issues.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      description: expect.stringContaining("/TCN/issues/TCN-15#comment-comment-1"),
    }));
    expect(issues.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      description: expect.stringContaining("gh auth status"),
    }));
  });

  it("dispatches from the PATCH comment when it contains a GitHub PR URL without # handoff markers", async () => {
    const createdReviewIssue = makeReviewIssue({
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-plain",
    });
    const plainHandoffComment = makeComment({
      id: "comment-plain",
      body: "PR pronto para revisão: https://github.com/acme/app/pull/212",
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => plainHandoffComment),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => []),
      create: vi.fn(async () => createdReviewIssue),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => []),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1", commentId: "comment-plain" });

    expect(result.kind).toBe("created");
    expect(issues.create).toHaveBeenCalledTimes(1);
    const [companyId, payload] = vi.mocked(issues.create).mock.calls[0] ?? [];
    expect(companyId).toBe("company-1");
    expect(payload).toMatchObject({
      title: "Revisar PR #212 de TCN-15",
      assigneeAgentId: "reviewer-1",
      parentId: "issue-1",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-plain",
    });
    expect(payload?.description).toContain("[TCN-15](/TCN/issues/TCN-15)");
    expect(payload?.description).toContain("/TCN/issues/TCN-15#comment-comment-plain");
    expect(payload?.description).toContain("Handoff atual");
    expect(payload?.description).toContain("https://github.com/acme/app/pull/212");
  });

  it("prefers the same-PATCH comment over stale work-product context to open a new review round", async () => {
    const createdReviewIssue = makeReviewIssue({
      id: "review-2",
      identifier: "TCN-60",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-round-2",
      status: "todo",
    });
    const donePreviousReviewIssue = makeReviewIssue({
      status: "done",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:work-product:wp-1:2026-03-29T21:10:00.000Z",
      createdAt: new Date("2026-03-29T21:47:05.000Z"),
    });
    const roundTwoComment = makeComment({
      id: "comment-round-2",
      body: "Novo round após ajustes. PR: https://github.com/acme/app/pull/212",
      createdAt: new Date("2026-03-29T22:40:00.000Z"),
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => roundTwoComment),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => [donePreviousReviewIssue]),
      create: vi.fn(async () => createdReviewIssue),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => [{
        id: "wp-1",
        issueId: "issue-1",
        companyId: "company-1",
        type: "pull_request",
        provider: "github",
        title: "PR #212",
        url: "https://github.com/acme/app/pull/212",
        externalId: null,
        metadata: null,
        isPrimary: true,
        createdAt: new Date("2026-03-29T21:10:00.000Z"),
        updatedAt: new Date("2026-03-29T21:10:00.000Z"),
      }]),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1", commentId: "comment-round-2" });

    expect(result.kind).toBe("created");
    expect(issues.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      originId: "github:acme/app:pr:212:comment:comment-round-2",
    }));
  });

  it("reuses an existing historical review ticket seeded after the same handoff comment", async () => {
    const currentComment = makeComment();
    const existingReviewIssue = makeReviewIssue({
      originKind: "manual",
      originId: null,
      createdAt: new Date("2026-03-29T21:47:05.000Z"),
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => currentComment),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => [existingReviewIssue]),
      create: vi.fn(),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => []),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1", commentId: "comment-1" });

    expect(result.kind).toBe("reused");
    expect(result.reviewIssue.id).toBe("review-1");
    expect(issues.create).not.toHaveBeenCalled();
  });

  it("recognizes an already-reviewed diff by origin identity", async () => {
    const existingReviewIssue = makeReviewIssue({
      status: "done",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-1",
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => makeComment()),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => [existingReviewIssue]),
      create: vi.fn(),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => []),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1", commentId: "comment-1" });

    expect(result.kind).toBe("already_reviewed");
    expect(result.reviewIssue.id).toBe("review-1");
    expect(issues.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: "the handoff comment explicitly says there is no new diff",
      commentId: "comment-restore",
      body: `## Handoff restaurado

- resumo: mantive o mesmo change set e restaurei o estado de handoff sem alterar codigo, commit, push ou PR.
- PR: https://github.com/acme/app/pull/212`,
      createdAt: new Date("2026-03-29T22:05:00.000Z"),
    },
    {
      scenario: "comment uses 'sem novas mudancas de codigo nesta rodada' wording",
      commentId: "comment-restore-pt",
      body: `## Handoff

- resumo: revisao tecnica automatizada 2 concluiu sem findings; PR segue pronto para revisao humana final, sem novas mudancas de codigo nesta rodada.
- PR: https://github.com/acme/app/pull/212`,
      createdAt: new Date("2026-03-29T22:10:00.000Z"),
    },
    {
      scenario: "operational comment uses 'nao houve diff novo' wording",
      commentId: "comment-operational-no-diff",
      body: `## Update

- A revisao tecnica ja concluiu sem findings relevantes e nao houve diff novo nem novo commit.
- Estado do codigo: inalterado desde o commit \`10215239\`
- PR: https://github.com/acme/app/pull/212`,
      createdAt: new Date("2026-03-29T22:12:00.000Z"),
    },
  ])("does not create a new review ticket when %s", async ({ commentId, body, createdAt }) => {
    const existingReviewIssue = makeReviewIssue({
      status: "done",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-previous",
      createdAt: new Date("2026-03-29T21:47:05.000Z"),
    });
    const handoffComment = makeComment({
      id: commentId,
      body,
      createdAt,
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => handoffComment),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => [existingReviewIssue]),
      create: vi.fn(),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => []),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1", commentId });

    expect(result.kind).toBe("already_reviewed");
    expect(result.reviewIssue.id).toBe("review-1");
    expect(result.dedupReason).toBe("no_new_diff_declared");
    expect(issues.create).not.toHaveBeenCalled();
  });

  it("treats repeated handoffs with the same explicit head sha as the same reviewed diff", async () => {
    const existingReviewIssue = makeReviewIssue({
      status: "done",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:head:10215239",
      createdAt: new Date("2026-03-29T21:47:05.000Z"),
    });
    const repeatedHandoff = makeComment({
      id: "comment-head-repeat",
      body: `## Handoff

- Head: \`10215239\`
- PR: https://github.com/acme/app/pull/212`,
      createdAt: new Date("2026-03-29T22:15:00.000Z"),
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => repeatedHandoff),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => [existingReviewIssue]),
      create: vi.fn(),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => []),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1", commentId: "comment-head-repeat" });

    expect(result.kind).toBe("already_reviewed");
    expect(result.reviewIssue.id).toBe("review-1");
    expect(result.dedupReason).toBe("exact_diff_identity");
    expect(issues.create).not.toHaveBeenCalled();
  });

  it("ignores reviewer recap comments and falls back to the latest explicit handoff", async () => {
    const existingReviewIssue = makeReviewIssue({
      status: "done",
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:comment:comment-handoff",
      createdAt: new Date("2026-03-29T21:47:05.000Z"),
    });
    const recapComment = makeComment({
      id: "comment-recap",
      body: `## Recap tecnico

- Revisao tecnica concluida sem findings relevantes.
- PR: https://github.com/acme/app/pull/212`,
      createdAt: new Date("2026-03-29T22:20:00.000Z"),
    });
    const handoffComment = makeComment({
      id: "comment-handoff",
      body: `## Handoff

- PR: https://github.com/acme/app/pull/212

@Revisor PR`,
      createdAt: new Date("2026-03-29T21:25:15.000Z"),
    });

    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-1", companyId: "company-1", name: "Revisor PR", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => null),
      listComments: vi.fn(async () => [recapComment, handoffComment]),
      list: vi.fn(async () => [existingReviewIssue]),
      create: vi.fn(),
    };
    const workProducts = {
      listForIssue: vi.fn(async () => []),
    };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1" });

    expect(result.kind).toBe("already_reviewed");
    expect(result.reviewIssue.id).toBe("review-1");
    expect(result.dedupReason).toBe("exact_diff_identity");
    expect(issues.create).not.toHaveBeenCalled();
  });

  it("returns reviewer_ambiguous noop when multiple agents match the reviewer reference", async () => {
    const agents = {
      resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: true })),
    };
    const issues = {
      getById: vi.fn(async () => makeIssue()),
      getComment: vi.fn(async () => null),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => []),
      create: vi.fn(),
    };
    const workProducts = { listForIssue: vi.fn(async () => []) };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1" });

    expect(result).toEqual({ kind: "noop", reason: "reviewer_ambiguous" });
    expect(issues.create).not.toHaveBeenCalled();
  });

  it("uses company technicalReviewerReference when resolving the reviewer", async () => {
    const createdReviewIssue = makeReviewIssue({
      originKind: REVIEW_DISPATCH_ORIGIN_KIND,
      originId: "github:acme/app:pr:212:description",
    });
    const companies = {
      getById: vi.fn(async () => ({ technicalReviewerReference: "custom-reviewer" })),
    };
    const agents = {
      resolveByReference: vi.fn(async () => ({
        agent: { id: "reviewer-x", companyId: "company-1", name: "Custom", status: "idle" },
        ambiguous: false,
      })),
    };
    const issues = {
      getById: vi.fn(async () => ({
        ...makeIssue(),
        description: "PR: https://github.com/acme/app/pull/212",
      })),
      getComment: vi.fn(async () => null),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => []),
      create: vi.fn(async () => createdReviewIssue),
    };
    const workProducts = { listForIssue: vi.fn(async () => []) };

    const svc = reviewDispatchService(testDb, createMockDeps({
      agents,
      issues,
      workProducts,
      companies,
    }));
    const result = await svc.dispatchForIssue({ issueId: "issue-1" });

    expect(result.kind).toBe("created");
    expect(companies.getById).toHaveBeenCalledWith("company-1");
    expect(agents.resolveByReference).toHaveBeenCalledWith("company-1", "custom-reviewer");
  });
});
