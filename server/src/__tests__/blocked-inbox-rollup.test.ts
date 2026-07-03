import { describe, expect, it } from "vitest";
import type { Issue, IssueBlockedInboxAttention } from "@paperclipai/shared";
import {
  buildBlockedInboxRollup,
  renderBlockedInboxRollupMarkdown,
} from "../services/blocked-inbox-rollup.js";

function attention(input: {
  state: IssueBlockedInboxAttention["state"];
  owner: IssueBlockedInboxAttention["owner"];
  stoppedSinceAt: string;
  reason?: IssueBlockedInboxAttention["reason"];
}): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: input.state,
    reason: input.reason ?? "blocked_by_assigned_backlog_issue",
    severity: "high",
    stoppedSinceAt: input.stoppedSinceAt,
    owner: input.owner,
    action: {
      label: "Resume parked blocker",
      detail: "Move the blocker back to in_progress.",
    },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: {
      externalDetailsRedacted: false,
      secretFieldsOmitted: true,
    },
  };
}

function issue(input: {
  id: string;
  identifier: string;
  title: string;
  blockedInboxAttention: IssueBlockedInboxAttention;
}): Issue & { blockedInboxAttention: IssueBlockedInboxAttention } {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    status: "blocked",
    priority: "medium",
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    blockedInboxAttention: input.blockedInboxAttention,
  } as Issue & { blockedInboxAttention: IssueBlockedInboxAttention };
}

describe("blocked inbox rollup", () => {
  it("groups by owner bucket, separates attention states, and selects stale/founder digest candidates", () => {
    const generatedAt = new Date("2026-07-20T00:00:00.000Z");
    const emAgentId = "11111111-1111-4111-8111-111111111111";
    const rollup = buildBlockedInboxRollup(
      [
        issue({
          id: "issue-1",
          identifier: "RR-1",
          title: "Engineering blocker",
          blockedInboxAttention: attention({
            state: "needs_attention",
            owner: { type: "agent", agentId: emAgentId, userId: null, label: null },
            stoppedSinceAt: "2026-07-01T00:00:00.000Z",
          }),
        }),
        issue({
          id: "issue-2",
          identifier: "RR-2",
          title: "Board confirmation",
          blockedInboxAttention: attention({
            state: "awaiting_decision",
            owner: { type: "board", agentId: null, userId: null, label: "Board" },
            stoppedSinceAt: "2026-07-19T00:00:00.000Z",
            reason: "pending_board_decision",
          }),
        }),
        issue({
          id: "issue-3",
          identifier: "RR-3",
          title: "Vendor reply",
          blockedInboxAttention: attention({
            state: "external_wait",
            owner: { type: "external", agentId: null, userId: null, label: null },
            stoppedSinceAt: "2026-07-02T00:00:00.000Z",
            reason: "external_owner_action",
          }),
        }),
      ],
      new Map([[emAgentId, { name: "Engineering Manager", role: "manager", title: "Engineering Manager" }]]),
      { generatedAt },
    );

    expect(rollup.totalBlocked).toBe(3);
    expect(rollup.ownerBuckets).toMatchObject({
      EM: 1,
      founder: 1,
      external: 1,
    });
    expect(rollup.stateCounts.needs_attention).toBe(1);
    expect(rollup.stateCounts.awaiting_decision).toBe(1);
    expect(rollup.stateCounts.external_wait).toBe(1);
    expect(rollup.staleCloseCandidates.map((item) => item.identifier)).toEqual(["RR-1", "RR-3"]);
    expect(rollup.founderDigestCandidates.map((item) => item.identifier)).toEqual(["RR-3", "RR-2"]);
  });

  it("renders markdown with grouped counts and candidate sections", () => {
    const rollup = buildBlockedInboxRollup(
      [
        issue({
          id: "issue-1",
          identifier: "RR-1",
          title: "Founder decision",
          blockedInboxAttention: attention({
            state: "awaiting_decision",
            owner: { type: "board", agentId: null, userId: null, label: "Board" },
            stoppedSinceAt: "2026-07-01T00:00:00.000Z",
            reason: "pending_board_decision",
          }),
        }),
      ],
      new Map(),
      { generatedAt: new Date("2026-07-20T00:00:00.000Z") },
    );

    const markdown = renderBlockedInboxRollupMarkdown(rollup);

    expect(markdown).toContain("Total blocked inbox items: 1");
    expect(markdown).toContain("- founder: 1");
    expect(markdown).toContain("- awaiting_decision: 1");
    expect(markdown).toContain("## Proposed Close Candidates (>14d stale)");
    expect(markdown).toContain("## Founder Digest Candidates");
    expect(markdown).toContain("RR-1");
  });
});
