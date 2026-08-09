import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue, IssueWatchdogSummary } from "@paperclipai/shared";
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
  watchdog: null,
};

function watchdog(overrides: Partial<IssueWatchdogSummary> = {}): IssueWatchdogSummary {
  return {
    id: "watchdog-1",
    companyId: baseIssue.companyId,
    issueId: baseIssue.id,
    watchdogAgentId: "agent-qa",
    instructions: "Keep this tree moving. Verify stopped leaves against tests and review state before accepting them.",
    status: "active",
    watchdogIssueId: null,
    lastObservedFingerprint: null,
    lastReviewedFingerprint: null,
    lastTriggeredAt: null,
    lastCompletedAt: null,
    triggerCount: 0,
    createdAt: new Date(Date.now() - 60 * 60_000),
    updatedAt: new Date(Date.now() - 60 * 60_000),
    ...overrides,
  };
}

const emptyWatchdogIssue: Issue = { ...baseIssue, watchdog: null };

const configuredWatchdogIssue: Issue = { ...baseIssue, watchdog: watchdog() };

const triggeredWatchdogIssue: Issue = {
  ...baseIssue,
  watchdog: watchdog({
    watchdogIssueId: "issue-watchdog-child",
    lastTriggeredAt: new Date(Date.now() - 10 * 60_000),
    triggerCount: 2,
  }),
};

const watchdogChildIssue: Issue = {
  ...baseIssue,
  id: "issue-watchdog-child",
  identifier: "PAP-9001",
  title: "Watchdog: keep the parent tree moving",
  originKind: "task_watchdog",
  originId: baseIssue.id,
  parentId: baseIssue.id,
  watchdog: null,
};

function WatchdogSurfaceStories() {
  return (
    <div className="space-y-8 p-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Watchdog row — empty (Set watchdog)
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties issue={emptyWatchdogIssue} onUpdate={() => undefined} inline />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Watchdog row — configured (agent + instructions)
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties issue={configuredWatchdogIssue} onUpdate={() => undefined} inline />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Watchdog row — triggered, linked to generated task
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={triggeredWatchdogIssue}
              childIssues={[watchdogChildIssue]}
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
  title: "Product/Task Watchdog surfaces",
  component: WatchdogSurfaceStories,
  parameters: {
    docs: {
      description: {
        component:
          "Surfaces the IssueProperties Watchdog row in empty / configured / triggered-and-linked variants for UX review of the task-watchdog configuration UI (PAP-11294).",
      },
    },
  },
} satisfies Meta<typeof WatchdogSurfaceStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WatchdogSurfaces: Story = {};
