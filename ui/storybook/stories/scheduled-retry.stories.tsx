import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue, IssueScheduledRetry } from "@paperclipai/shared";
import { IssueScheduledRetryCard } from "@/components/IssueScheduledRetryCard";
import { IssueProperties } from "@/components/IssueProperties";
import {
  storybookExecutionWorkspaces,
  storybookIssueDocuments,
  storybookIssues,
} from "../fixtures/paperclipData";

const issueDocumentSummaries = storybookIssueDocuments.map(({ body: _body, ...summary }) => summary);

const baseIssue: Issue = {
  ...storybookIssues[0]!,
  planDocument: storybookIssueDocuments.find((document) => document.key === "plan") ?? null,
  documentSummaries: issueDocumentSummaries,
  currentExecutionWorkspace: storybookExecutionWorkspaces[0]!,
};

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();
const justNow = () => new Date(Date.now() + 5_000).toISOString();
const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString();

const transientRetry: IssueScheduledRetry = {
  runId: "run-aaaaaaaa-1111-1111-1111-111111111111",
  status: "scheduled_retry",
  agentId: baseIssue.assigneeAgentId ?? "agent-1",
  agentName: "ClaudeCoder",
  retryOfRunId: "run-prev-2222-2222-2222-222222222222",
  scheduledRetryAt: inFifteenMinutes(),
  scheduledRetryAttempt: 4,
  scheduledRetryReason: "transient_failure",
  retryExhaustedReason: null,
  error: "Upstream provider returned 502",
  errorCode: "upstream_502",
};

const continuationRetry: IssueScheduledRetry = {
  ...transientRetry,
  runId: "run-bbbbbbbb-3333-3333-3333-333333333333",
  retryOfRunId: "run-prev-4444-4444-4444-444444444444",
  scheduledRetryAt: inTwoDays(),
  scheduledRetryAttempt: 1,
  scheduledRetryReason: "max_turns_continuation",
  error: null,
};

const dueNowRetry: IssueScheduledRetry = {
  ...transientRetry,
  runId: "run-cccccccc-5555-5555-5555-555555555555",
  scheduledRetryAt: justNow(),
};

const issueWithRetry = (retry: IssueScheduledRetry): Issue => ({
  ...baseIssue,
  scheduledRetry: retry,
});

function ScheduledRetrySurfaceStories() {
  return (
    <div className="space-y-8 p-6">
      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          IssueScheduledRetryCard - transient failure, in 15m
        </div>
        <IssueScheduledRetryCard issueId={baseIssue.id} scheduledRetry={transientRetry} />
      </section>

      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          IssueScheduledRetryCard - max-turn continuation, in 2d
        </div>
        <IssueScheduledRetryCard issueId={baseIssue.id} scheduledRetry={continuationRetry} />
      </section>

      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          IssueScheduledRetryCard - due now (overdue)
        </div>
        <IssueScheduledRetryCard issueId={baseIssue.id} scheduledRetry={dueNowRetry} />
      </section>

      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          IssueScheduledRetryCard - returns null with no live scheduled retry
        </div>
        <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          (intentionally renders nothing for issues without a live scheduled retry)
        </div>
        <IssueScheduledRetryCard issueId={baseIssue.id} scheduledRetry={null} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Scheduled retry row - hidden when no live retry
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties issue={baseIssue} onUpdate={() => undefined} inline />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Scheduled retry row - transient failure, in 15m
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={issueWithRetry(transientRetry)}
              onUpdate={() => undefined}
              inline
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Scheduled retry row - continuation, in 2d
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={issueWithRetry(continuationRetry)}
              onUpdate={() => undefined}
              inline
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Scheduled retry row - due now
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={issueWithRetry(dueNowRetry)}
              onUpdate={() => undefined}
              inline
            />
          </div>
        </section>
      </div>
    </div>
  );
}

const meta = {
  title: "Product/Issue Scheduled retry surfaces",
  component: ScheduledRetrySurfaceStories,
  parameters: {
    docs: {
      description: {
        component:
          "Surfaces the IssueScheduledRetryCard and IssueProperties Scheduled retry row in transient/continuation/due-now variants for UX review. The card mounts above IssueMonitorActivityCard and the property row sits sibling-to (and above) Monitor.",
      },
    },
  },
} satisfies Meta<typeof ScheduledRetrySurfaceStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ScheduledRetrySurfaces: Story = {};
