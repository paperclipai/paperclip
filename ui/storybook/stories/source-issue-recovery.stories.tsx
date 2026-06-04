import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import type { IssueRecoveryAction, IssueRelationIssueSummary } from "@paperclipai/shared";
import { Eye, ExternalLink, OctagonAlert, RefreshCw, TriangleAlert } from "lucide-react";
import { IssueRecoveryActionCard } from "@/components/IssueRecoveryActionCard";
import { IssueRow } from "@/components/IssueRow";
import { IssueBlockedNotice } from "@/components/IssueBlockedNotice";
import { storybookAgentMap, storybookAgents, createIssue } from "../fixtures/paperclipData";

const claudeAgent = storybookAgents.find((agent) => agent.name.toLowerCase().startsWith("claude")) ?? storybookAgents[0]!;
const codexAgent = storybookAgents.find((agent) => agent.name.toLowerCase().startsWith("codex")) ?? storybookAgents[0]!;

function StoryFrame({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header>
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Source-issue recovery
          </div>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          {description ? (
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </header>
        {children}
      </div>
    </main>
  );
}

function buildAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    companyId: "company-storybook",
    sourceIssueId: "00000000-0000-0000-0000-0000000000ff",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: claudeAgent.id,
    ownerUserId: null,
    previousOwnerAgentId: codexAgent.id,
    returnOwnerAgentId: codexAgent.id,
    cause: "missing_disposition",
    fingerprint: "fp",
    evidence: {
      summary: "Run finished without picking a disposition. The PR has tests passing on CI.",
      sourceRunId: "7accd7a4-c9ca-4db2-9233-3228a037cc09",
      correctiveRunId: "2606404d-3859-4142-ba37-3228a037cc09",
    },
    nextAction: "Choose and record a valid issue disposition without copying transcript content.",
    wakePolicy: { type: "wake_owner" },
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    lastAttemptAt: "2026-04-20T11:55:00.000Z",
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-04-20T11:55:00.000Z",
    updatedAt: "2026-04-20T11:55:00.000Z",
    ...overrides,
  };
}

function CardPanel({ caption, action, forcedState, canFalsePositive }: {
  caption: string;
  action: IssueRecoveryAction;
  forcedState?: React.ComponentProps<typeof IssueRecoveryActionCard>["forcedState"];
  canFalsePositive?: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {caption}
      </div>
      <IssueRecoveryActionCard
        action={action}
        agentMap={storybookAgentMap}
        forcedState={forcedState}
        onResolve={() => {}}
        canFalsePositive={canFalsePositive}
      />
    </section>
  );
}

function AllStatesPanel() {
  return (
    <div className="grid gap-5 lg:grid-cols-1">
      <CardPanel caption="State 1 · Recovery needed (default)" action={buildAction()} canFalsePositive />
      <CardPanel
        caption="State 2 · Recovery in progress"
        action={buildAction({ outcome: "delegated", attemptCount: 2 })}
        forcedState="in_progress"
        canFalsePositive
      />
      <CardPanel
        caption="State 3 · Observing active run (watchdog)"
        action={buildAction({
          kind: "active_run_watchdog",
          wakePolicy: { type: "monitor", intervalLabel: "in 4m" },
          evidence: { summary: "The active run has been silent for 7 minutes. Last log: 'continuing checks…'" },
          nextAction: "Observe the active run; intervene only if the silence persists past timeout.",
        })}
      />
      <CardPanel
        caption="State 4 · Recovery escalated"
        action={buildAction({
          status: "escalated",
          attemptCount: 3,
          wakePolicy: { type: "board_escalation" },
          evidence: {
            summary: "Three corrective wakes failed. The recovery owner has not produced a disposition.",
            sourceRunId: "7accd7a4-c9ca-4db2-9233-3228a037cc09",
          },
          nextAction: "Board operator: assign an invokable owner or record a manual resolution.",
        })}
        canFalsePositive
      />
      <CardPanel
        caption="State 5 · Recovery resolved"
        action={buildAction({
          status: "resolved",
          outcome: "restored",
          resolvedAt: "2026-04-20T12:01:00.000Z",
          nextAction: "Issue restored to a valid disposition.",
        })}
      />
    </div>
  );
}

function buildBlocker(
  overrides: Partial<IssueRelationIssueSummary> = {},
): IssueRelationIssueSummary {
  return {
    id: "blocker-1",
    identifier: "PAP-9065",
    title: "Add full company search page",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: claudeAgent.id,
    assigneeUserId: null,
    ...overrides,
  };
}

function BlockerNoticePanel() {
  return (
    <div className="space-y-4">
      <IssueBlockedNotice
        issueStatus="blocked"
        blockers={[
          buildBlocker({ activeRecoveryAction: buildAction() }),
          buildBlocker({
            id: "blocker-2",
            identifier: "PAP-9099",
            title: "Watchdog: PR review pipeline silent",
            activeRecoveryAction: buildAction({ kind: "active_run_watchdog" }),
          }),
          buildBlocker({
            id: "blocker-3",
            identifier: "PAP-9073",
            title: "Recovery escalated for stranded run",
            status: "blocked",
            activeRecoveryAction: buildAction({ status: "escalated" }),
          }),
          buildBlocker({
            id: "blocker-4",
            identifier: "PAP-9051",
            title: "Bare blocker without recovery state",
          }),
        ]}
      />
    </div>
  );
}

type RunCardRecoveryState = "needed" | "in_progress" | "observe_only" | "escalated";

const RUN_CARD_RECOVERY_TONE: Record<RunCardRecoveryState, { icon: typeof TriangleAlert; label: string; className: string }> = {
  needed: {
    icon: TriangleAlert,
    label: "Recovery needed",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  in_progress: {
    icon: RefreshCw,
    label: "Recovery in progress",
    className: "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  observe_only: {
    icon: Eye,
    label: "Observing active run",
    className: "border-border bg-muted text-muted-foreground",
  },
  escalated: {
    icon: OctagonAlert,
    label: "Recovery escalated",
    className: "border-red-500/60 bg-red-500/15 text-red-700 dark:text-red-300",
  },
};

function ActiveRunRecoveryChip({ state }: { state: RunCardRecoveryState }) {
  const tone = RUN_CARD_RECOVERY_TONE[state];
  const Icon = tone.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.className}`}
      role="status"
      aria-label={tone.label}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {tone.label}
    </span>
  );
}

function ActiveRunCardMock({
  identifier,
  title,
  recoveryState,
}: {
  identifier: string;
  title: string;
  recoveryState: RunCardRecoveryState;
}) {
  return (
    <div className="flex h-[260px] w-full max-w-[320px] flex-col overflow-hidden rounded-xl border border-cyan-500/25 bg-cyan-500/[0.04] shadow-[0_16px_40px_rgba(6,182,212,0.08)]">
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
              </span>
              <span className="text-sm font-medium">CodexCoder</span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>Live now</span>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
            <ExternalLink className="h-2.5 w-2.5" />
          </span>
        </div>
        <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-xs">
          <span className="line-clamp-2 text-cyan-700 dark:text-cyan-300">
            {identifier} - {title}
          </span>
          <div className="mt-1.5">
            <ActiveRunRecoveryChip state={recoveryState} />
          </div>
        </div>
      </div>
      <div className="flex-1 px-3 py-2 text-[11px] text-muted-foreground">Live transcript…</div>
    </div>
  );
}

function ActiveRunPanel() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ActiveRunCardMock
        identifier="PAP-9065"
        title="Add full company search page"
        recoveryState="needed"
      />
      <ActiveRunCardMock
        identifier="PAP-9099"
        title="Watchdog: PR review pipeline silent"
        recoveryState="observe_only"
      />
      <ActiveRunCardMock
        identifier="PAP-9073"
        title="Recovery escalated for stranded run"
        recoveryState="escalated"
      />
      <ActiveRunCardMock
        identifier="PAP-9101"
        title="Recovery in progress: delegated"
        recoveryState="in_progress"
      />
    </div>
  );
}

function InboxRowPanel() {
  const baseIssue = createIssue();
  return (
    <div className="rounded-lg border border-border/70 bg-background/80">
      <IssueRow
        issue={{
          ...baseIssue,
          identifier: "PAP-9065",
          title: "Add full company search page",
          status: "in_progress",
          activeRecoveryAction: buildAction(),
        }}
      />
      <IssueRow
        issue={{
          ...baseIssue,
          id: "issue-recovery-watch",
          identifier: "PAP-9099",
          title: "Watchdog: PR review pipeline silent",
          status: "in_progress",
          activeRecoveryAction: buildAction({ kind: "active_run_watchdog" }),
        }}
      />
      <IssueRow
        issue={{
          ...baseIssue,
          id: "issue-recovery-escalated",
          identifier: "PAP-9073",
          title: "Recovery escalated for stranded run",
          status: "blocked",
          activeRecoveryAction: buildAction({ status: "escalated" }),
        }}
      />
    </div>
  );
}

const meta = {
  title: "Paperclip/Source Issue Recovery",
  component: AllStatesPanel,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AllStatesPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RecoveryActionCardStates: Story = {
  render: () => (
    <StoryFrame
      title="Recovery action card states"
      description="Five states required by the source-issue recovery contract: needed, in progress, observe-only watchdog, escalated, resolved."
    >
      <AllStatesPanel />
    </StoryFrame>
  ),
};

export const InboxRowChips: Story = {
  render: () => (
    <StoryFrame
      title="Inbox row recovery chips"
      description="Source rows expose recovery state inline; no synthetic sibling row appears for source-scoped recovery."
    >
      <InboxRowPanel />
    </StoryFrame>
  ),
};

export const BlockerNoticeRecoveryIndicators: Story = {
  render: () => (
    <StoryFrame
      title="Blocker notice recovery indicators"
      description="Blocker chips inline a recovery indicator when the blocker has an active recovery action. Plain blockers stay clean."
    >
      <BlockerNoticePanel />
    </StoryFrame>
  ),
};

export const ActiveRunPanelRecoveryChips: Story = {
  render: () => (
    <StoryFrame
      title="Active run panel recovery chips"
      description="Active run cards on the dashboard expose recovery state on the linked source issue."
    >
      <ActiveRunPanel />
    </StoryFrame>
  ),
};
