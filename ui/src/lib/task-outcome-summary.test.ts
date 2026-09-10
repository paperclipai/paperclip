import { describe, expect, it } from "vitest";
import type {
  Issue,
  IssueDocumentSummary,
  IssueWorkProduct,
} from "@paperclipai/shared";
import {
  buildTaskOutcomeModel,
  taskOutcomeSafeHref,
  taskOutcomeWorkProductHref,
  type BuildTaskOutcomeModelInput,
  type TaskOutcomeOverview,
} from "./task-outcome-summary";

function workProduct(
  overrides: Partial<IssueWorkProduct> & { id: string },
): IssueWorkProduct {
  return {
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: "Output",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as IssueWorkProduct;
}

function doc(
  overrides: Partial<IssueDocumentSummary> & { id: string; key: string },
): IssueDocumentSummary {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    title: null,
    format: "markdown",
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as IssueDocumentSummary;
}

function overview(
  overrides: Partial<TaskOutcomeOverview> = {},
): TaskOutcomeOverview {
  return {
    blocked: false,
    project: null,
    parent: null,
    blocker: null,
    pullRequests: [],
    delivery: null,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<BuildTaskOutcomeModelInput> = {},
): BuildTaskOutcomeModelInput {
  return {
    issue: {
      id: "issue-1",
      description: "Ship the thing",
      status: "todo",
      blockedBy: [],
      blockerAttention: undefined,
      unblockDescriptor: undefined,
      blockedInboxAttention: null,
      activeRecoveryAction: null,
      planDocument: null,
      legacyPlanDocument: null,
    } as unknown as Issue,
    childIssues: [],
    workProducts: [],
    documents: [],
    ancestors: [],
    project: null,
    overview: null,
    ...overrides,
  };
}

function doneIssue(extra: Record<string, unknown> = {}): Issue {
  return { ...baseInput().issue, status: "done", ...extra } as unknown as Issue;
}

describe("buildTaskOutcomeModel result", () => {
  it("stays unknown without inventing completion", () => {
    const model = buildTaskOutcomeModel(baseInput());

    expect(model.resultKind).toBe("unknown");
    expect(model.workKind).toBe("unknown");
    expect(model.evidence).toEqual([]);
    expect(model.requestedText).toBe("Ship the thing");
    expect(model.requestedTruncated).toBe(false);
    expect(model.blockerMessage).toBeNull();
    expect(model.prStateAvailable).toBe(false);
    expect(model.pullRequests).toEqual([]);
  });

  it("leaves done unclassified when no code evidence exists", () => {
    // Regression: absence of PR/work-product evidence must not print
    // "no code changes" — the row carries no explicit marker.
    const model = buildTaskOutcomeModel(
      baseInput({ issue: doneIssue(), overview: overview() }),
    );

    expect(model.resultKind).toBe("done_unclassified");
    expect(model.workKind).toBe("unknown");
    expect(model.resultNote).toContain("evidence not recorded");
  });

  it("honours the explicit deliveryKind marker both ways", () => {
    const noncode = buildTaskOutcomeModel(
      baseInput({
        issue: doneIssue({ deliveryKind: "non_code" }),
        workProducts: [
          workProduct({ id: "wp-doc", type: "document", summary: "Memo." }),
        ],
        overview: overview(),
      }),
    );
    expect(noncode.resultKind).toBe("done_noncode");
    expect(noncode.workKind).toBe("noncode");

    const code = buildTaskOutcomeModel(
      baseInput({
        issue: doneIssue({ deliveryKind: "code" }),
        overview: overview(),
      }),
    );
    expect(code.resultKind).toBe("done_with_code");
    expect(code.workKind).toBe("code");
  });

  it("counts overview PRs and delivery as code signals", () => {
    const model = buildTaskOutcomeModel(
      baseInput({
        issue: doneIssue(),
        overview: overview({
          pullRequests: [
            {
              url: "https://example.test/repo/pull/7",
              number: 7,
              repository: "acme/repo",
              state: "open",
              updatedAt: null,
              stale: false,
            },
          ],
        }),
      }),
    );

    expect(model.resultKind).toBe("done_with_code");
    expect(model.workKind).toBe("code");
  });

  it("does not mark a reopened task merged from an old merged PR", () => {
    // Regression: historical merged metadata must not override the current
    // outcome. Chips come from the projection only.
    const model = buildTaskOutcomeModel(
      baseInput({
        issue: {
          ...baseInput().issue,
          status: "in_progress",
        } as unknown as Issue,
        workProducts: [
          workProduct({
            id: "wp-pr",
            type: "pull_request",
            title: "Old PR",
            url: "https://example.test/repo/pull/12",
            summary: "Old work.",
            metadata: { repo: "acme/repo", number: 12, state: "merged" },
          }),
        ],
        overview: overview({
          delivery: {
            phase: "merged",
            artifactReady: true,
            candidateGeneration: 1,
            readiness: "accepted",
            policy: null,
            reviewStatus: "approved",
            blockingFindings: 0,
            queuePosition: null,
            nextAction: null,
            lastEventAt: "2026-02-01T00:00:00Z",
            mergedAt: "2026-02-01T00:00:00Z",
          },
        }),
      }),
    );

    expect(model.resultKind).toBe("recorded_evidence");
    expect(model.pullRequests).toEqual([]);
    expect(model.prStateAvailable).toBe(true);
  });

  it("does not treat work-product PR metadata as a merge proof", () => {
    const model = buildTaskOutcomeModel(
      baseInput({
        issue: doneIssue(),
        workProducts: [
          workProduct({
            id: "wp-pr",
            type: "pull_request",
            title: "PR",
            url: "https://example.test/repo/pull/12",
            summary: "Work.",
            metadata: { repo: "acme/repo", number: 12, state: "merged" },
          }),
        ],
        overview: overview(),
      }),
    );

    expect(model.resultKind).toBe("done_with_code");
    expect(model.pullRequests).toEqual([]);
  });

  it("marks merged only from current delivery evidence on a done task", () => {
    const model = buildTaskOutcomeModel(
      baseInput({
        issue: doneIssue(),
        overview: overview({
          pullRequests: [
            {
              url: "https://example.test/repo/pull/7",
              number: 7,
              repository: "acme/repo",
              state: "merged",
              updatedAt: null,
              stale: false,
            },
            {
              url: "https://example.test/repo/pull/8",
              number: 8,
              repository: "acme/repo",
              state: "open",
              updatedAt: null,
              stale: false,
            },
          ],
          delivery: {
            phase: "merged",
            artifactReady: true,
            candidateGeneration: 1,
            readiness: "accepted",
            policy: null,
            reviewStatus: "approved",
            blockingFindings: 0,
            queuePosition: null,
            nextAction: null,
            lastEventAt: "2026-02-01T00:00:00Z",
            mergedAt: "2026-02-01T00:00:00Z",
          },
        }),
      }),
    );

    expect(model.resultKind).toBe("merged");
    // One merged + one open PR is not a merged outcome on its own — chips
    // stay independent either way.
    expect(model.pullRequests.map((pr) => pr.state).sort()).toEqual([
      "merged",
      "open",
    ]);
  });

  it("keeps mixed merged/open PRs as chips without a merged outcome", () => {
    const model = buildTaskOutcomeModel(
      baseInput({
        issue: doneIssue(),
        overview: overview({
          pullRequests: [
            {
              url: "https://example.test/repo/pull/7",
              number: 7,
              repository: "acme/repo",
              state: "merged",
              updatedAt: null,
              stale: false,
            },
            {
              url: "https://example.test/repo/pull/8",
              number: 8,
              repository: "acme/repo",
              state: "open",
              updatedAt: null,
              stale: false,
            },
          ],
          delivery: null,
        }),
      }),
    );

    expect(model.resultKind).toBe("done_with_code");
    expect(model.pullRequests).toHaveLength(2);
  });

});

describe("buildTaskOutcomeModel children", () => {
  it("counts cancelled separately from completed", () => {
    const model = buildTaskOutcomeModel(
      baseInput({
        childIssues: [
          { id: "c1", identifier: "PAP-2", title: "Done", status: "done" },
          {
            id: "c2",
            identifier: "PAP-3",
            title: "Dropped",
            status: "cancelled",
          },
          { id: "c3", identifier: "PAP-4", title: "Open", status: "todo" },
        ],
      }),
    );

    expect(model.childrenTotal).toBe(3);
    expect(model.childrenCompleted).toBe(1);
    expect(model.childrenCancelled).toBe(1);
    // Cancelled is closed, not remaining.
    expect(model.openChildren.map((child) => child.id)).toEqual(["c3"]);
  });
});

describe("buildTaskOutcomeModel blocker and links", () => {
  it("prefers the overview blocker, then descriptor, then recovery", () => {
    const fromOverview = buildTaskOutcomeModel(
      baseInput({
        issue: {
          ...baseInput().issue,
          unblockDescriptor: { owner: "board", action: "Local action" },
        } as unknown as Issue,
        overview: overview({
          blocked: true,
          blocker: {
            message: "Waiting on database migration",
            ownerLabel: "Platform team",
            nextAction: "Approve the migration run",
            issues: [{ id: "b-1", identifier: "PAP-9", title: "Migrate", status: "todo" }],
          },
        }),
      }),
    );
    expect(fromOverview.blockerMessage).toBe("Waiting on database migration");
    expect(fromOverview.blockerIssue?.identifier).toBe("PAP-9");

    const fromDescriptor = buildTaskOutcomeModel(
      baseInput({
        issue: {
          ...baseInput().issue,
          unblockDescriptor: { owner: "board", action: "Board must decide" },
        } as unknown as Issue,
        overview: overview(),
      }),
    );
    expect(fromDescriptor.blockerMessage).toBe("Board must decide");
    expect(fromDescriptor.blockerOwnerLabel).toBe("Board");
  });

  it("orders plan and specification docs first, then the rest", () => {
    const model = buildTaskOutcomeModel(
      baseInput({
        issue: {
          ...baseInput().issue,
          legacyPlanDocument: {
            key: "plan",
            body: "old",
            source: "issue_description",
          },
        } as unknown as Issue,
        documents: [
          doc({ id: "d-notes", key: "notes", title: "Notes" }),
          doc({ id: "d-spec", key: "specification", title: null }),
          doc({ id: "d-plan", key: "plan", title: "Plan" }),
        ],
        overview: overview(),
      }),
    );

    expect(model.planDocs.map((entry) => entry.key)).toEqual([
      "specification",
      "plan",
      "notes",
    ]);
    expect(model.planDocs[0]?.hash).toBe("#document-specification");
  });
});

describe("task outcome href safety", () => {
  it("drops executable schemes but keeps web and relative links", () => {
    expect(taskOutcomeSafeHref("javascript:alert(1)")).toBeNull();
    expect(taskOutcomeSafeHref("java\nscript:alert(1)")).toBeNull();
    expect(taskOutcomeSafeHref("data:text/html,hi")).toBeNull();
    expect(taskOutcomeSafeHref("ftp://example.test/x")).toBeNull();
    expect(taskOutcomeSafeHref("https://example.test/p?q=1")).toBe(
      "https://example.test/p?q=1",
    );
    expect(taskOutcomeSafeHref("/files/a.png")).toBe("/files/a.png");
    expect(taskOutcomeSafeHref(null)).toBeNull();
  });

  it("never surfaces an unsafe work-product link", () => {
    expect(
      taskOutcomeWorkProductHref({
        url: "javascript:alert(1)",
        metadata: { openPath: "/files/a.png" },
      }),
    ).toBe("/files/a.png");
    expect(
      taskOutcomeWorkProductHref({ url: null, metadata: null }),
    ).toBeNull();
  });
});
