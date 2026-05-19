import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { SourceResolvedFoldCallout } from "@/components/SourceResolvedFoldCallout";
import { SourceResolvedFoldBadge } from "@/components/SourceResolvedFoldBadge";
import type { SourceResolvedWatchdogFold } from "@/lib/source-resolved-watchdog-fold";

function StoryFrame({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <header>
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Active-run watchdog · source-resolved fold
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

function buildFold(overrides: Partial<SourceResolvedWatchdogFold> = {}): SourceResolvedWatchdogFold {
  return {
    sourceIssueId: "00000000-0000-0000-0000-000093220000",
    sourceIssueIdentifier: "PAP-9322",
    sourceIssueStatus: "done",
    sameRunEvidenceKind: "activity",
    sameRunEvidenceId: "f49d4f8b-c2ee-4b3d-9d24-32deadbeef01",
    sameRunEvidenceAt: "2026-05-12T18:14:33.000Z",
    silenceStartedAt: "2026-05-12T18:30:00.000Z",
    silenceAgeMs: 18 * 60_000,
    evaluationIssueId: null,
    evaluationIssueIdentifier: null,
    cleanup: {
      attempted: true,
      outcome: "terminated",
      adapterType: "claude_local",
      pid: 23912,
      processGroupId: 23912,
      error: null,
    },
    ...overrides,
  };
}

const finalizedAt = "2026-05-12T18:48:11.000Z";

function DefaultPanel() {
  return <SourceResolvedFoldCallout fold={buildFold()} finalizedAt={finalizedAt} />;
}

const meta = {
  title: "Paperclip/Source-resolved Fold",
  component: DefaultPanel,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DefaultPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FoldCalloutFullEvidence: Story = {
  render: () => (
    <StoryFrame
      title="Run details — source-resolved fold callout"
      description="Rendered above the log/events area on /agents/:id/runs/:runId when the watchdog auto-folds a stale run whose source already reached a terminal disposition through durable same-run activity."
    >
      <SourceResolvedFoldCallout fold={buildFold()} finalizedAt={finalizedAt} />
    </StoryFrame>
  ),
};

export const FoldCalloutWithEvaluationIssue: Story = {
  render: () => (
    <StoryFrame
      title="Fold callout with legacy evaluation issue"
      description="When a stale_active_run_evaluation issue existed, the fold closes it `done` and surfaces the deep-link for forensic continuity."
    >
      <SourceResolvedFoldCallout
        fold={buildFold({
          evaluationIssueId: "00000000-0000-0000-0000-0000eval0001",
          evaluationIssueIdentifier: "PAP-9323",
          cleanup: {
            attempted: true,
            outcome: "termination_sent_still_running",
            adapterType: "claude_local",
            pid: 23912,
            processGroupId: 23912,
            error: null,
          },
        })}
        finalizedAt={finalizedAt}
      />
    </StoryFrame>
  ),
};

export const FoldCalloutCleanupFailed: Story = {
  render: () => (
    <StoryFrame
      title="Fold callout with cleanup error"
      description="Process cleanup is best-effort; the audit message surfaces failure mode and original outcome token (kept as `title` on the span)."
    >
      <SourceResolvedFoldCallout
        fold={buildFold({
          cleanup: {
            attempted: true,
            outcome: "failed",
            adapterType: "claude_local",
            pid: 23912,
            processGroupId: 23912,
            error: "kill ESRCH (process already gone)",
          },
        })}
        finalizedAt={finalizedAt}
      />
    </StoryFrame>
  ),
};

export const FoldCalloutCancelledSource: Story = {
  render: () => (
    <StoryFrame
      title="Fold callout when the source was cancelled"
      description="When the source issue terminated as `cancelled`, the run finalizes as `cancelled` and the callout reflects the source status."
    >
      <SourceResolvedFoldCallout
        fold={buildFold({
          sourceIssueStatus: "cancelled",
          cleanup: {
            attempted: false,
            outcome: "no_process_metadata",
            adapterType: null,
            pid: null,
            processGroupId: null,
            error: null,
          },
        })}
        finalizedAt={finalizedAt}
      />
    </StoryFrame>
  ),
};

export const RunRowBadgeContext: Story = {
  render: () => (
    <StoryFrame
      title="Run-row Source-resolved badge"
      description="Chip placed alongside the existing Profile / silence chips on each run row. Subdued emerald — distinct from the green status checkmark, but not a hot warning."
    >
      <div className="space-y-3 rounded-lg border border-border/60 bg-background/60 p-4 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-foreground">Run</span>
          <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-foreground">7accd7a4</code>
          <span className="text-muted-foreground">by ClaudeCoder</span>
          <span className="rounded-md border border-border px-1.5 py-0.5 capitalize text-muted-foreground">succeeded</span>
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
            Completed
          </span>
          <SourceResolvedFoldBadge />
          <span className="ml-auto text-muted-foreground">3m ago</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-foreground">Run</span>
          <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-foreground">2606404d</code>
          <span className="text-muted-foreground">by ClaudeCoder</span>
          <span className="rounded-md border border-border px-1.5 py-0.5 capitalize text-muted-foreground">succeeded</span>
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
            Completed
          </span>
          <span className="ml-auto text-muted-foreground">12m ago</span>
        </div>
      </div>
    </StoryFrame>
  ),
};
