import type { ReactNode } from "react";
import type {
  InterruptedRunRecovery,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import { IssueScheduledRetryCard } from "@/components/IssueScheduledRetryCard";
import { IssueRecoveryActionCard } from "@/components/IssueRecoveryActionCard";
import { IssueBlockedNotice } from "@/components/IssueBlockedNotice";
import { Card } from "@/components/ui/card";

/**
 * UX lab for PAP-16740 (Phase 5B) — the interrupted-run recovery states from
 * the Phase 4 spec (PAP-16737). Renders the REAL components against the Phase
 * 5A read model so every variant can be verified in a browser without waiting
 * for a task to actually get stuck. Route: /ux-lab/interrupted-run-recovery
 */

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const baseRecovery: InterruptedRunRecovery = {
  state: "retry_queued",
  interruptedRunId: "7accd7a4-1111-4111-8111-111111111111",
  interruptedAt: "2026-04-18T19:55:13.000Z",
  errorCode: "server_shutdown_interrupted",
  successorRunId: null,
  successorStatus: null,
  receiptId: "9f31be02-2222-4222-8222-222222222222",
  receiptOutcome: "queued",
  suppressionReason: null,
  escalationReason: null,
  attempt: 1,
  maxAttempts: 3,
  recoveryActionId: null,
  owner: null,
  nextAction: null,
};

const baseRetry: IssueScheduledRetry = {
  runId: "b2c3d4e5-3333-4333-8333-333333333333",
  status: "scheduled_retry",
  agentId: AGENT_ID,
  agentName: "CodexCoder",
  retryOfRunId: "7accd7a4-1111-4111-8111-111111111111",
  scheduledRetryAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  scheduledRetryAttempt: 1,
  scheduledRetryReason: "process_lost",
  retryExhaustedReason: null,
  error: null,
  errorCode: "server_shutdown_interrupted",
};

const recoveryAction = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "company-1",
  issueId: "issue-1",
  sourceIssueId: "issue-1",
  recoveryIssueId: null,
  kind: "stranded_assigned_issue",
  cause: "process_lost",
  status: "active",
  ownerType: "agent",
  ownerAgentId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: null,
  previousOwnerAgentId: AGENT_ID,
  returnOwnerAgentId: AGENT_ID,
  outcome: null,
  nextAction: "Confirm the task is unowned, then restart it on a fresh run.",
  evidence: {
    summary: "Run was interrupted by a server restart and no successor started.",
    interruptedRunId: "7accd7a4-1111-4111-8111-111111111111",
    recoveryReceiptId: "9f31be02-2222-4222-8222-222222222222",
  },
  attemptCount: 3,
  maxAttempts: 3,
  timeoutAt: null,
  resolvedAt: null,
  createdAt: "2026-04-18T19:56:00.000Z",
  updatedAt: "2026-04-18T19:56:00.000Z",
} as unknown as IssueRecoveryAction;

function leaf(
  overrides: Partial<IssueRelationIssueSummary> = {},
): IssueRelationIssueSummary {
  return {
    id: "leaf-1",
    identifier: "PAP-16728",
    title: "Recovery receipt never recorded for the interrupted run",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    ...overrides,
  };
}

function parent(leaves: IssueRelationIssueSummary[]): IssueRelationIssueSummary {
  return {
    id: "blocker-1",
    identifier: "PAP-16720",
    title: "Direct blocker — waiting on the chain below",
    status: "blocked",
    priority: "medium",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    terminalBlockers: leaves,
  };
}

function LabSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-background/85 p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Variant({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
        {label}
      </div>
      <Card className="block border-border/60 p-3">{children}</Card>
    </div>
  );
}

export function InterruptedRunRecoveryUxLab() {
  return (
    <div className="min-h-screen bg-muted/20 p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <div className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            PAP-16740 · Phase 5B
          </div>
          <h1 className="mt-1 text-xl font-semibold text-foreground">
            Interrupted-run recovery states
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The four recovery-slot variants and the blocked-parent leaf naming from the
            Phase 4 spec, rendered with the real components.
          </p>
        </header>

        <LabSection
          title="The recovery slot — one card per task"
          description="Arbitrated in priority order: an open recovery action beats a live successor, which beats a queued retry, which beats an exhausted one."
        >
          <Variant label="A · Retry queued — interrupted, successor scheduled">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={baseRetry}
              interruptedRunRecovery={baseRecovery}
            />
          </Variant>

          <Variant label="A · Retry queued — non-restart interruption reason">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={baseRetry}
              interruptedRunRecovery={{ ...baseRecovery, errorCode: "process_lost" }}
            />
          </Variant>

          <Variant label="B · Recovered after restart — successor live, no action offered">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={{ ...baseRetry, status: "running" }}
              interruptedRunRecovery={{
                ...baseRecovery,
                state: "recovered",
                successorRunId: "b2c3d4e5-3333-4333-8333-333333333333",
                successorStatus: "running",
                attempt: 2,
              }}
            />
          </Variant>

          <Variant label="C · Retry exhausted — bounded reason rendered verbatim">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={{ ...baseRetry, status: "cancelled" }}
              interruptedRunRecovery={{
                ...baseRecovery,
                state: "retry_exhausted",
                receiptOutcome: "escalated",
                escalationReason:
                  "Bounded retry exhausted after 3 scheduled attempts; no further automatic retry will be queued.",
                attempt: 3,
              }}
            />
          </Variant>

          <Variant label="C · Automatic retry withheld — suppression reason verbatim">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={{ ...baseRetry, status: "cancelled" }}
              interruptedRunRecovery={{
                ...baseRecovery,
                state: "suppressed",
                receiptOutcome: "suppressed",
                suppressionReason: "company budget exhausted for this billing period",
              }}
            />
          </Variant>

          <Variant label="C · No recovery scheduled — the original PAP-16728 shape">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={null}
              interruptedRunRecovery={{
                ...baseRecovery,
                state: "pathless",
                receiptId: null,
                receiptOutcome: null,
                attempt: null,
                maxAttempts: null,
              }}
            />
          </Variant>

          <Variant label="D · Recovery owner required — the retry card stands down">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={baseRetry}
              interruptedRunRecovery={{ ...baseRecovery, state: "recovery_owner_required" }}
              activeRecoveryAction={recoveryAction}
            />
            <IssueRecoveryActionCard
              action={recoveryAction}
              interruptedRunRecovery={{
                ...baseRecovery,
                state: "recovery_owner_required",
                receiptOutcome: "escalated",
                attempt: 3,
              }}
            />
          </Variant>

          <Variant label="Suppressed — a healthy live run shows no card at all">
            <IssueScheduledRetryCard
              issueId="issue-1"
              issueStatus="in_progress"
              scheduledRetry={null}
              interruptedRunRecovery={null}
            />
            <p className="text-xs text-muted-foreground">
              Nothing renders above this line — live-run and successful-handoff suppression
              are unchanged.
            </p>
          </Variant>
        </LabSection>

        <LabSection
          title="Blocked parent — name the exact unhealthy leaf"
          description="The parent names the deepest unhealthy task, never just the direct blocker edge."
        >
          <Variant label="Suppressed leaf needs an owner (C)">
            <IssueBlockedNotice
              issueStatus="blocked"
              blockers={[parent([leaf({ interruptedRunRecoveryState: "suppressed" })])]}
            />
          </Variant>

          <Variant label="Leaf resumes on its own (A)">
            <IssueBlockedNotice
              issueStatus="blocked"
              blockers={[parent([leaf({ interruptedRunRecoveryState: "retry_queued" })])]}
            />
          </Variant>

          <Variant label="Several interrupted leaves">
            <IssueBlockedNotice
              issueStatus="blocked"
              blockers={[
                parent([
                  leaf({ interruptedRunRecoveryState: "retry_exhausted" }),
                  leaf({
                    id: "leaf-2",
                    identifier: "PAP-16729",
                    title: "Second interrupted leaf",
                    interruptedRunRecoveryState: "retry_queued",
                  }),
                ]),
              ]}
            />
          </Variant>

          <Variant label="Recovered leaf stays healthy — blue waiting variant survives">
            <IssueBlockedNotice
              issueStatus="blocked"
              liveIssueIds={new Set(["blocker-1"])}
              blockerAttention={{
                state: "covered",
                reason: "active_dependency",
                unresolvedBlockerCount: 1,
                coveredBlockerCount: 1,
                stalledBlockerCount: 0,
                attentionBlockerCount: 0,
                sampleBlockerIdentifier: "PAP-16720",
                sampleStalledBlockerIdentifier: null,
              }}
              blockers={[parent([leaf({ interruptedRunRecoveryState: "recovered" })])]}
            />
          </Variant>

          <Variant label="Legacy payload — no leaf state, today's notice byte-for-byte">
            <IssueBlockedNotice issueStatus="blocked" blockers={[parent([leaf()])]} />
          </Variant>
        </LabSection>
      </div>
    </div>
  );
}
