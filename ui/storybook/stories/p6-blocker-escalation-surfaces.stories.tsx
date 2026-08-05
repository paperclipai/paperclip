import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue, IssueWatchdogSummary } from "@paperclipai/shared";
import { WatchdogEscalationCard } from "@/components/WatchdogEscalationCard";
import { NeedsAttentionBanner } from "@/components/NeedsAttentionBanner";
import { UnblockPropertySection } from "@/components/UnblockPropertySection";
import { DeadEndBadge, DEAD_END_ROW_TINT } from "@/components/DeadEndBadge";
import { BlockedInboxView } from "@/components/BlockedInboxView";
import { StatusIcon } from "@/components/StatusIcon";
import { defaultIssueFilterState } from "@/lib/issue-filters";
import { cn } from "@/lib/utils";

const HOUR = 60 * 60 * 1000;

const leaf = {
  id: "issue-leaf",
  identifier: "PAP-15099",
  title: "SecurityEngineer re-review",
  status: "blocked" as const,
  priority: "high" as const,
  assigneeAgentId: null,
  assigneeUserId: null,
};

function blockerAttention(
  state: NonNullable<Issue["blockerAttention"]>["state"],
  sampleBlockerIdentifier: string | null = null,
): NonNullable<Issue["blockerAttention"]> {
  return {
    state,
    reason: state === "needs_attention" ? "attention_required" : null,
    unresolvedBlockerCount: state === "none" ? 0 : 1,
    coveredBlockerCount: state === "covered" ? 1 : 0,
    stalledBlockerCount: state === "stalled" ? 1 : 0,
    attentionBlockerCount: state === "needs_attention" ? 1 : 0,
    sampleBlockerIdentifier,
    sampleStalledBlockerIdentifier: null,
  };
}

function baseIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-15079",
    identifier: "PAP-15079",
    title: "P2: SecurityEngineer review — write-back auth gap",
    status: "blocked",
    ancestors: [{ id: "issue-15023", identifier: "PAP-15023", title: "Status-cards plan" }],
    blockerAttention: blockerAttention("needs_attention", "PAP-15099"),
    blockedInboxAttention: {
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_chain_stalled",
      severity: "high",
      stoppedSinceAt: new Date(Date.now() - 17 * HOUR).toISOString(),
      owner: { type: "board", agentId: null, userId: null, label: "Board" },
      action: {
        label: "Reopen PAP-15099 → re-review",
        detail: "Its findings are complete; it needs a re-review path re-opened.",
      },
      sourceIssue: null,
      leafIssue: leaf,
      recoveryIssue: null,
      approvalId: null,
      interactionId: null,
      sampleIssueIdentifier: "PAP-15099",
      redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    },
    unblockDescriptor: { owner: "board", action: "Reopen PAP-15099 → re-review" },
    ...overrides,
  } as unknown as Issue;
}

function escalatedWatchdog(): IssueWatchdogSummary {
  return {
    id: "wd-1",
    companyId: "company-storybook",
    issueId: "issue-15023",
    watchdogAgentId: "agent-wd",
    instructions: null,
    status: "active",
    watchdogIssueId: null,
    lastObservedFingerprint: "a8f7c210",
    lastReviewedFingerprint: null,
    restorationFingerprint: "a8f7c210",
    restorationVerificationPending: false,
    restorationAttemptCount: 3,
    restorationAttempts: [
      { attempt: 1, fingerprint: "a8f7c210", runId: "run-aaaa1111", mutations: [{ type: "add_comment", issueId: "issue-fix-15112" }], completedAt: new Date(Date.now() - 15 * HOUR).toISOString() },
      { attempt: 2, fingerprint: "a8f7c210", runId: "run-bbbb2222", mutations: [{ type: "update_issue", issueId: "issue-leaf", update: { status: "todo" } }], completedAt: new Date(Date.now() - 14 * HOUR).toISOString() },
      { attempt: 3, fingerprint: "a8f7c210", runId: "run-cccc3333", mutations: [], completedAt: new Date(Date.now() - 13 * HOUR).toISOString() },
    ],
    restorationEscalatedAt: new Date(Date.now() - 13 * HOUR),
    lastTriggeredAt: new Date(Date.now() - 13 * HOUR),
    lastCompletedAt: null,
    triggerCount: 3,
    createdAt: new Date(Date.now() - 20 * HOUR),
    updatedAt: new Date(Date.now() - 13 * HOUR),
  };
}

const watchedIssue = baseIssue({
  id: "issue-15023",
  identifier: "PAP-15023",
  title: "Status-cards plan",
  ancestors: [],
  watchdog: escalatedWatchdog(),
});

const meta = {
  title: "Product/P6 Blocker & escalation surfaces",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "P6 surfaces for PAP-15146: needs_attention blocked chains (inbox tier grouping, detail banner + breadcrumb, dead-end sub-task marker) and exhausted-watchdog escalations (attempt-history card). Verified at 1440×900 and 390×844 in dark theme.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Surface 2b — the watchdog escalation attempt-history card (core deliverable). */
export const WatchdogEscalation: Story = {
  render: () => (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <WatchdogEscalationCard
        issue={watchedIssue}
        watchdogAgentName="task-watchdog"
        deadEndLeaf={leaf}
        onReopenDeadEnd={() => undefined}
        onReassign={() => undefined}
        onDismiss={() => undefined}
      />
    </div>
  ),
};

/** Surface 1b + 1c — needs-attention banner, Unblock right-rail, dead-end sub-task marker. */
export const NeedsAttentionDetail: Story = {
  render: () => {
    const issue = baseIssue();
    return (
      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <NeedsAttentionBanner
            issue={issue}
            ownerName="Board"
            onReopenDeadEnd={() => undefined}
            onReassign={() => undefined}
          />
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">Sub-tasks</h3>
            <div className="rounded-lg border border-border">
              <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5 text-sm">
                <StatusIcon status="done" />
                <span className="font-mono text-xs text-muted-foreground">PAP-15112</span>
                <span>Fix findings (CodexCoder)</span>
              </div>
              <div className={cn("flex items-center gap-2 rounded-b-lg px-3 py-2.5 text-sm", DEAD_END_ROW_TINT)}>
                <StatusIcon status="blocked" />
                <span className="font-mono text-xs text-muted-foreground">PAP-15099</span>
                <span>SecurityEngineer re-review</span>
                <DeadEndBadge className="ml-1">dead end</DeadEndBadge>
              </div>
            </div>
          </div>
        </div>
        <aside className="rounded-lg border border-border p-3">
          <UnblockPropertySection
            issue={issue}
            ownerName="Board"
            onReopen={() => undefined}
            onReassign={() => undefined}
          />
        </aside>
      </div>
    );
  },
};

const blockedInboxIssues: Issue[] = [
  baseIssue({
    id: "issue-15023",
    identifier: "PAP-15023",
    title: "Watchdog escalated — 3 restoration attempts failed",
    watchdog: escalatedWatchdog(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activeRecoveryAction: { status: "escalated" } as any,
  }),
  baseIssue(),
  baseIssue({
    id: "issue-15145",
    identifier: "PAP-15145",
    title: "OIDC re-review — awaiting approval",
    blockerAttention: blockerAttention("covered"),
    blockedInboxAttention: {
      kind: "blocked",
      state: "awaiting_decision",
      reason: "pending_board_decision",
      severity: "medium",
      stoppedSinceAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      owner: { type: "board", agentId: null, userId: null, label: "Board" },
      action: { label: "Decide approval", detail: null },
      sourceIssue: null,
      leafIssue: null,
      recoveryIssue: null,
      approvalId: "ap-1",
      interactionId: null,
      sampleIssueIdentifier: null,
      redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    },
  }),
  baseIssue({
    id: "issue-15161",
    identifier: "PAP-15161",
    title: "P4: watchdog restoration verification",
    blockerAttention: blockerAttention("covered"),
    blockedInboxAttention: {
      kind: "blocked",
      state: "recovery_open",
      reason: "open_recovery_issue",
      severity: "high",
      stoppedSinceAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      owner: { type: "agent", agentId: null, userId: null, label: "CodexCoder" },
      action: { label: "Resolve recovery", detail: null },
      sourceIssue: null,
      leafIssue: null,
      recoveryIssue: null,
      approvalId: null,
      interactionId: null,
      sampleIssueIdentifier: "PAP-15229",
      redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    },
  }),
];

/** Surface 1a — the Blocked inbox tab, grouped into the three human-action tiers. */
export const BlockedInboxTiers: Story = {
  render: () => {
    // Serve the blocked-attention fixture for this story's query only.
    useEffect(() => {
      const original = window.fetch;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, window.location.origin);
        if (url.pathname.match(/\/api\/companies\/[^/]+\/issues$/) && url.searchParams.get("attention") === "blocked") {
          return Response.json(blockedInboxIssues);
        }
        return original(input, init);
      };
      return () => {
        window.fetch = original;
      };
    }, []);
    return (
      <div className="mx-auto max-w-4xl p-6">
        <h2 className="mb-1 text-lg font-semibold">Blocked</h2>
        <p className="mb-4 text-sm text-muted-foreground">Work that needs you, routed here the moment it stalls.</p>
        <BlockedInboxView
          companyId="company-storybook"
          searchQuery=""
          agentNameById={new Map()}
          issueLinkState={undefined}
          groupBy="attention_tier"
          sortBy="urgency"
          issueFilters={defaultIssueFilterState}
          currentUserId={null}
          liveIssueIds={new Set()}
          subtreeLiveCounts={new Map()}
          workspaceFilterContext={{}}
          showStatusColumn
          showIdentifierColumn
          showUpdatedColumn
        />
      </div>
    );
  },
};
