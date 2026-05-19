import { describe, expect, it } from "vitest";
import type {
  Approval,
  IssueComment,
  IssueDocumentSummary,
  IssueThreadInteraction,
  IssueTreeObservability,
  IssueValidationHistory,
  IssueWorkProduct,
} from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "@/api/heartbeats";
import type { RunForIssue } from "@/api/activity";
import { buildEvidenceItems } from "./build-evidence";

function comment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "c1",
    companyId: "co",
    issueId: "iss",
    authorType: "agent",
    authorAgentId: "ag-1",
    authorUserId: null,
    body: "Hello world",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-05-19T12:00:00Z"),
    updatedAt: new Date("2026-05-19T12:00:00Z"),
    ...overrides,
  } as IssueComment;
}

describe("buildEvidenceItems (LET-467)", () => {
  it("returns an empty array when no sources are provided", () => {
    expect(buildEvidenceItems({})).toEqual([]);
  });

  it("normalizes documents, work products, validation, approvals, runs, comments and tree events", () => {
    const docs: IssueDocumentSummary[] = [
      {
        id: "d-1",
        companyId: "co",
        issueId: "iss",
        key: "plan",
        title: "Plan doc",
        format: "markdown",
        latestRevisionId: "rev-1",
        latestRevisionNumber: 2,
        createdByAgentId: "ag-1",
        createdByUserId: null,
        updatedByAgentId: "ag-1",
        updatedByUserId: null,
        createdAt: new Date("2026-05-19T10:00:00Z"),
        updatedAt: new Date("2026-05-19T11:00:00Z"),
      },
    ];
    const wps: IssueWorkProduct[] = [
      {
        id: "wp-1",
        companyId: "co",
        projectId: null,
        issueId: "iss",
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "pull_request",
        provider: "github",
        externalId: "85",
        title: "PR #85",
        url: null,
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "unknown",
        summary: "ship slice",
        metadata: null,
        createdByRunId: null,
        createdAt: new Date("2026-05-19T09:30:00Z"),
        updatedAt: new Date("2026-05-19T11:30:00Z"),
      },
    ];
    const history: IssueValidationHistory = {
      issueId: "iss",
      latest: null,
      entries: [
        {
          id: "v-1",
          issueId: "iss",
          source: "validator_report",
          label: "validator",
          verdict: "PASS",
          completionScore: 9,
          report: null,
          summary: "All criteria met",
          criteriaChecked: [],
          evidence: [],
          blockingIssues: [],
          exactFixIfFailed: null,
          stageId: null,
          stageType: null,
          decisionOutcome: null,
          revisionNumber: null,
          bodyPreview: null,
          actorAgentId: "ag-2",
          actorUserId: null,
          createdByRunId: null,
          createdAt: new Date("2026-05-19T10:30:00Z"),
        },
      ],
    };
    const approvals: Approval[] = [
      {
        id: "a-1",
        companyId: "co",
        type: "approve_ceo_strategy",
        requestedByAgentId: "ag-1",
        requestedByUserId: null,
        status: "approved",
        payload: {},
        decisionNote: "ok",
        decidedByUserId: "u-1",
        decidedAt: new Date("2026-05-19T11:45:00Z"),
        createdAt: new Date("2026-05-19T11:30:00Z"),
        updatedAt: new Date("2026-05-19T11:45:00Z"),
      },
    ];
    const interactions: IssueThreadInteraction[] = [
      {
        id: "int-1",
        companyId: "co",
        issueId: "iss",
        kind: "final_delivery",
        title: "Final",
        status: "resolved",
        continuationPolicy: "none",
        createdAt: new Date("2026-05-19T11:50:00Z").toISOString(),
        updatedAt: new Date("2026-05-19T11:55:00Z").toISOString(),
        resolvedAt: new Date("2026-05-19T11:56:00Z").toISOString(),
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
      } as unknown as IssueThreadInteraction,
    ];
    const runs: RunForIssue[] = [
      {
        runId: "r-1",
        status: "completed",
        agentId: "agent-abcd-efgh",
        adapterType: "claude",
        startedAt: "2026-05-19T11:00:00Z",
        finishedAt: "2026-05-19T11:10:00Z",
        createdAt: "2026-05-19T10:55:00Z",
        invocationSource: "manual",
        usageJson: null,
        resultJson: null,
      },
    ];
    const liveRuns: LiveRunForIssue[] = [
      {
        id: "live-1",
        status: "running",
        invocationSource: "wake",
        triggerDetail: null,
        startedAt: "2026-05-19T12:00:00Z",
        finishedAt: null,
        createdAt: "2026-05-19T12:00:00Z",
        agentId: "ag-3",
        agentName: "EAOS Frontend",
        adapterType: "claude",
      },
    ];
    const active: ActiveRunForIssue = {
      id: "live-1",
      status: "running",
      invocationSource: "wake",
      triggerDetail: null,
      startedAt: "2026-05-19T12:00:00Z",
      finishedAt: null,
      createdAt: "2026-05-19T12:00:00Z",
      agentId: "ag-3",
      agentName: "EAOS Frontend",
      adapterType: "claude",
    };
    const tree: IssueTreeObservability = {
      issueId: "iss",
      generatedAt: new Date("2026-05-19T12:30:00Z"),
      summary: {
        issueId: "iss",
        issueCount: 1,
        activeIssueCount: 1,
        doneIssueCount: 0,
        cancelledIssueCount: 0,
        blockedIssueCount: 0,
        runCount: 1,
        activeRunCount: 1,
        failedRunCount: 0,
        errorEventCount: 0,
        costCents: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        runtimeMs: 0,
        lastActivityAt: new Date("2026-05-19T12:00:00Z"),
      },
      nodes: [],
      blockerExplanations: [],
      timeline: [
        {
          id: "t-1",
          kind: "run",
          severity: "info",
          issueId: "iss",
          issueIdentifier: "LET-460",
          issueTitle: "Mission",
          runId: "r-1",
          timestamp: new Date("2026-05-19T11:10:00Z"),
          label: "run finished",
          message: "ok",
          costCents: 0,
        },
      ],
    };

    const items = buildEvidenceItems({
      documents: docs,
      workProducts: wps,
      validation: history,
      approvals,
      interactions,
      runs,
      liveRuns,
      activeRun: active,
      comments: [comment()],
      treeObservability: tree,
    });

    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("document");
    expect(kinds).toContain("work_product");
    expect(kinds).toContain("validation");
    expect(kinds).toContain("approval");
    expect(kinds).toContain("final_delivery");
    expect(kinds).toContain("run");
    expect(kinds).toContain("live_run");
    expect(kinds).toContain("comment");
    expect(kinds).toContain("tree_event");

    // De-duplicates live runs against the active run by id.
    const liveItems = items.filter((i) => i.kind === "live_run");
    expect(liveItems.length).toBe(1);

    // Sorted newest first.
    const timestamps = items
      .map((i) => i.timestamp)
      .filter((t): t is string => typeof t === "string");
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(Date.parse(timestamps[i - 1]!) >= Date.parse(timestamps[i]!)).toBe(true);
    }

    // Final delivery destination is masked, not raw.
    const fd = items.find((i) => i.kind === "final_delivery");
    expect(fd?.summary).not.toBeNull();
    expect(fd?.summary ?? "").not.toContain("1234567890493");
    expect(fd?.summary ?? "").toMatch(/…|Telegram|destination/i);
  });

  it("redacts secret-like text in comment bodies before placing them in evidence", () => {
    const items = buildEvidenceItems({
      comments: [
        comment({
          id: "c-secret",
          body: "Authorization: Bearer abc123def456ghi789jkl0mno1",
        }),
      ],
    });
    const found = items.find((i) => i.id === "cmt:c-secret");
    expect(found).toBeDefined();
    expect(found?.summary ?? "").not.toContain("abc123def456ghi789jkl0mno1");
    expect(found?.summary ?? "").toContain("[REDACTED]");
  });
});
