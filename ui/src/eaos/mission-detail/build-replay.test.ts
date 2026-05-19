import { describe, expect, it } from "vitest";
import type {
  ActivityEvent,
  IssueComment,
  IssueDocumentSummary,
  IssueTreeObservability,
  IssueValidationHistory,
  IssueWorkProduct,
} from "@paperclipai/shared";
import type { RunForIssue } from "@/api/activity";
import { buildReplayItems } from "./build-replay";

function comment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "c1",
    companyId: "co",
    issueId: "iss",
    authorType: "agent",
    authorAgentId: "ag-1",
    authorUserId: null,
    body: "Hello",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-05-19T11:00:00Z"),
    updatedAt: new Date("2026-05-19T11:00:00Z"),
    ...overrides,
  } as IssueComment;
}

describe("buildReplayItems (LET-467)", () => {
  it("returns an empty array on empty input", () => {
    expect(buildReplayItems({})).toEqual([]);
  });

  it("merges runs, comments, and activity into a newest-first feed", () => {
    const runs: RunForIssue[] = [
      {
        runId: "r-1",
        status: "completed",
        agentId: "agent-x",
        adapterType: "claude",
        startedAt: "2026-05-19T10:00:00Z",
        finishedAt: "2026-05-19T10:30:00Z",
        createdAt: "2026-05-19T09:55:00Z",
        invocationSource: "manual",
        usageJson: null,
        resultJson: null,
      },
    ];
    const activity: ActivityEvent[] = [
      {
        id: "a-1",
        companyId: "co",
        actorType: "system",
        actorId: "sys",
        action: "issue.status.changed",
        entityType: "issue",
        entityId: "iss",
        agentId: null,
        runId: null,
        details: { to: "in_progress" },
        createdAt: new Date("2026-05-19T11:15:00Z"),
      },
    ];

    const items = buildReplayItems({
      runs,
      comments: [comment()],
      activity,
    });

    // Newest first: activity (11:15) > comment (11:00) > run finished (10:30)
    expect(items.map((i) => i.id)).toEqual(["act:a-1", "cmt:c1", "run:r-1"]);
    // Runs carry their status as state.
    expect(items.find((i) => i.kind === "run")?.state).toBe("completed");
    expect(items.find((i) => i.kind === "run")?.severity).toBe("success");
  });

  it("classifies validation verdicts by severity", () => {
    const items = buildReplayItems({
      validation: {
        issueId: "iss",
        latest: null,
        entries: [
          {
            id: "v-pass",
            issueId: "iss",
            source: "validator_report",
            label: "validator",
            verdict: "PASS",
            completionScore: 9,
            report: null,
            summary: null,
            criteriaChecked: [],
            evidence: [],
            blockingIssues: [],
            exactFixIfFailed: null,
            stageId: null,
            stageType: null,
            decisionOutcome: null,
            revisionNumber: null,
            bodyPreview: null,
            actorAgentId: null,
            actorUserId: null,
            createdByRunId: null,
            createdAt: new Date("2026-05-19T10:00:00Z"),
          },
          {
            id: "v-fail",
            issueId: "iss",
            source: "validator_report",
            label: "validator",
            verdict: "REQUEST_CHANGES",
            completionScore: 3,
            report: null,
            summary: null,
            criteriaChecked: [],
            evidence: [],
            blockingIssues: [],
            exactFixIfFailed: null,
            stageId: null,
            stageType: null,
            decisionOutcome: null,
            revisionNumber: null,
            bodyPreview: null,
            actorAgentId: null,
            actorUserId: null,
            createdByRunId: null,
            createdAt: new Date("2026-05-19T11:00:00Z"),
          },
        ],
      },
    });
    expect(items.find((i) => i.id === "val:v-pass")?.severity).toBe("success");
    // REQUEST_CHANGES maps to "warning" via the validation severity helper.
    expect(items.find((i) => i.id === "val:v-fail")?.severity).toBe("warning");
  });

  it("masks secret-like text and final-delivery destinations", () => {
    const items = buildReplayItems({
      comments: [
        comment({
          id: "c-secret",
          body: "token=ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ],
      interactions: [
        {
          id: "int-1",
          companyId: "co",
          issueId: "iss",
          kind: "final_delivery",
          status: "resolved",
          continuationPolicy: "none",
          createdAt: new Date("2026-05-19T12:00:00Z").toISOString(),
          updatedAt: new Date("2026-05-19T12:00:00Z").toISOString(),
          resolvedAt: new Date("2026-05-19T12:00:00Z").toISOString(),
          payload: {
            version: 1,
            destination: {
              platform: "telegram",
              chatId: "1234567890493",
              threadId: "12345103",
              messageId: "9999910",
            },
            issue: { id: "iss", title: "t" },
            message: { format: "markdown", body: "ok" },
            artifacts: [],
          },
          result: {
            version: 1,
            outcome: "delivered",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    });
    const cmt = items.find((i) => i.id === "cmt:c-secret");
    expect(cmt?.summary ?? "").not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(cmt?.summary ?? "").toContain("[REDACTED]");

    const fd = items.find((i) => i.id === "int:int-1");
    expect(fd?.summary ?? "").not.toContain("1234567890493");
  });

  it("redacts secret-shaped values from user-sourced titles in every replay category", () => {
    const SECRET = "abc123def456ghi789jkl0mno1pqr2";
    const BEARER = `Bearer ${SECRET}`;
    const documents: IssueDocumentSummary[] = [
      {
        id: "d-secret",
        companyId: "co",
        issueId: "iss",
        key: "plan",
        title: BEARER,
        format: "markdown",
        latestRevisionId: "rev-1",
        latestRevisionNumber: 1,
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        createdAt: new Date("2026-05-19T10:00:00Z"),
        updatedAt: new Date("2026-05-19T11:00:00Z"),
      },
    ];
    const workProducts: IssueWorkProduct[] = [
      {
        id: "wp-secret",
        companyId: "co",
        projectId: null,
        issueId: "iss",
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "pull_request",
        provider: "github",
        externalId: "x",
        title: BEARER,
        url: null,
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "unknown",
        summary: null,
        metadata: null,
        createdByRunId: null,
        createdAt: new Date("2026-05-19T09:30:00Z"),
        updatedAt: new Date("2026-05-19T09:35:00Z"),
      },
    ];
    const validation: IssueValidationHistory = {
      issueId: "iss",
      latest: null,
      entries: [
        {
          id: "v-secret",
          issueId: "iss",
          source: "validator_report",
          label: BEARER,
          verdict: null,
          completionScore: null,
          report: null,
          summary: null,
          criteriaChecked: [],
          evidence: [],
          blockingIssues: [],
          exactFixIfFailed: null,
          stageId: null,
          stageType: null,
          decisionOutcome: null,
          revisionNumber: null,
          bodyPreview: null,
          actorAgentId: null,
          actorUserId: null,
          createdByRunId: null,
          createdAt: new Date("2026-05-19T10:30:00Z"),
        },
      ],
    };
    // Replay-side interaction titles are constructed from `interaction.kind`
    // (or for final_delivery, `result.outcome`/`status`), not from the
    // user-controlled `interaction.title` field — so they are safe by
    // construction at the replay layer. Title-side redaction for interactions
    // is exercised on the evidence layer instead (build-evidence.test.ts).
    const commentWithTitleSecret: IssueComment = comment({
      id: "c-title-secret",
      body: "ok",
      presentation: { title: BEARER } as IssueComment["presentation"],
    });
    const tree: IssueTreeObservability = {
      issueId: "iss",
      generatedAt: new Date("2026-05-19T12:30:00Z"),
      summary: {
        issueId: "iss",
        issueCount: 0,
        activeIssueCount: 0,
        doneIssueCount: 0,
        cancelledIssueCount: 0,
        blockedIssueCount: 0,
        runCount: 0,
        activeRunCount: 0,
        failedRunCount: 0,
        errorEventCount: 0,
        costCents: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        runtimeMs: 0,
        lastActivityAt: null,
      },
      nodes: [],
      blockerExplanations: [],
      timeline: [
        {
          id: "t-secret",
          kind: "run",
          severity: "info",
          issueId: "iss",
          issueIdentifier: "LET-460",
          issueTitle: "Mission",
          runId: null,
          timestamp: new Date("2026-05-19T11:10:00Z"),
          label: BEARER,
          message: null,
          costCents: 0,
        },
      ],
    };

    const items = buildReplayItems({
      documents,
      workProducts,
      validation,
      comments: [commentWithTitleSecret],
      treeObservability: tree,
    });

    const targetIds = [
      "doc:d-secret",
      "wp:wp-secret",
      "val:v-secret",
      "cmt:c-title-secret",
      "tree:t-secret",
    ];
    for (const id of targetIds) {
      const match = items.find((i) => i.id === id);
      expect(match, `replay item ${id} should be present`).toBeDefined();
      expect(match!.title).not.toContain(SECRET);
      expect(match!.title.toLowerCase()).toContain("[redacted]");
    }
  });
});
