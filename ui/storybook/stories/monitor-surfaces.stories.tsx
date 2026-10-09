import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue } from "@paperclipai/shared";
import { IssueMonitorBanner, IssueMonitorComposerStrip } from "@/components/IssueMonitorBanner";
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

const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000);
const inTwoHours = () => new Date(Date.now() + 2 * 60 * 60_000);

const monitoredIssue: Issue = {
  ...baseIssue,
  monitorNextCheckAt: inFiveMinutes(),
  monitorNotes: "Polling Greptile for completed analysis.",
  monitorAttemptCount: 2,
  executionPolicy: {
    ...(baseIssue.executionPolicy ?? { mode: "normal", commentRequired: true, stages: [] }),
    monitor: {
      nextCheckAt: inFiveMinutes().toISOString(),
      notes: "Polling Greptile for completed analysis.",
      kind: "external_service",
      scheduledBy: "assignee",
      serviceName: "Greptile",
      externalRef: "https://app.greptile.com/runs/abc123",
    },
  },
};

const triggeredIssue: Issue = {
  ...baseIssue,
  monitorNextCheckAt: null,
  monitorLastTriggeredAt: new Date(Date.now() - 3 * 60_000),
  monitorAttemptCount: 3,
  monitorNotes: "Greptile review was checked and needs another pass.",
  executionPolicy: {
    ...(baseIssue.executionPolicy ?? { mode: "normal", commentRequired: true, stages: [] }),
  },
  executionState: {
    ...(baseIssue.executionState ?? {
      status: "pending",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    }),
    monitor: null,
  },
};

const clearedIssue: Issue = {
  ...baseIssue,
  monitorNextCheckAt: null,
  monitorLastTriggeredAt: null,
  monitorAttemptCount: 0,
  monitorNotes: null,
  executionPolicy: {
    ...(baseIssue.executionPolicy ?? { mode: "normal", commentRequired: true, stages: [] }),
  },
  executionState: {
    ...(baseIssue.executionState ?? {
      status: "pending",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    }),
    monitor: {
      status: "cleared",
      nextCheckAt: null,
      lastTriggeredAt: null,
      attemptCount: 0,
      notes: null,
      scheduledBy: "board",
      kind: null,
      serviceName: null,
      externalRef: null,
      timeoutAt: null,
      maxAttempts: null,
      recoveryPolicy: null,
      clearedAt: new Date(Date.now() - 60_000).toISOString(),
      clearReason: "manual",
    },
  },
};

const executionStateStub = baseIssue.executionState ?? {
  status: "pending" as const,
  currentStageId: null,
  currentStageIndex: null,
  currentStageType: null,
  currentParticipant: null,
  returnAssignee: null,
  reviewRequest: null,
  completedStageIds: [],
  lastDecisionId: null,
  lastDecisionOutcome: null,
};

type StoryMonitor = NonNullable<NonNullable<Issue["executionState"]>["monitor"]>;

function withMonitor(monitor: StoryMonitor | null): Issue {
  return {
    ...baseIssue,
    monitorNextCheckAt: monitor?.nextCheckAt ? new Date(monitor.nextCheckAt) : null,
    monitorAttemptCount: monitor?.attemptCount ?? 0,
    executionState: { ...executionStateStub, monitor },
    scheduledRetry: null,
  };
}

const scheduledMonitorIssue = withMonitor({
  status: "scheduled",
  nextCheckAt: inTwoHours().toISOString(),
  lastTriggeredAt: null,
  attemptCount: 1,
  notes: null,
  scheduledBy: "assignee",
  kind: "external_service",
  serviceName: "vercel-deploy",
  externalRef: null,
  timeoutAt: null,
  maxAttempts: null,
  recoveryPolicy: null,
  clearedAt: null,
  clearReason: null,
});

const retryingMonitorIssue = withMonitor({
  status: "scheduled",
  nextCheckAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  lastTriggeredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  attemptCount: 3,
  notes: null,
  scheduledBy: "assignee",
  kind: "external_service",
  serviceName: "deploy health",
  externalRef: null,
  timeoutAt: null,
  maxAttempts: null,
  recoveryPolicy: null,
  clearedAt: null,
  clearReason: null,
});

const dueNowMonitorIssue = withMonitor({
  status: "scheduled",
  nextCheckAt: new Date(Date.now() - 10_000).toISOString(),
  lastTriggeredAt: null,
  attemptCount: 1,
  notes: null,
  scheduledBy: "assignee",
  kind: null,
  serviceName: "vercel-deploy",
  externalRef: null,
  timeoutAt: null,
  maxAttempts: null,
  recoveryPolicy: null,
  clearedAt: null,
  clearReason: null,
});

const overdueMonitorIssue = withMonitor({
  status: "scheduled",
  nextCheckAt: new Date(Date.now() - 18 * 60_000).toISOString(),
  lastTriggeredAt: null,
  attemptCount: 2,
  notes: null,
  scheduledBy: "assignee",
  kind: null,
  serviceName: "vercel-deploy",
  externalRef: null,
  timeoutAt: null,
  maxAttempts: null,
  recoveryPolicy: null,
  clearedAt: null,
  clearReason: null,
});

function MonitorSurfaceStories() {
  return (
    <div className="space-y-8 p-6">
      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Pinned top banner — scheduled (2h wait, external service)
        </div>
        <IssueMonitorBanner
          issue={scheduledMonitorIssue}
          onCheckNow={() => undefined}
          checkingNow={false}
        />

        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Pinned top banner — retrying (attempt 3)
        </div>
        <IssueMonitorBanner issue={retryingMonitorIssue} onCheckNow={() => undefined} />

        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Pinned top banner — due now
        </div>
        <IssueMonitorBanner issue={dueNowMonitorIssue} onCheckNow={() => undefined} />

        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Pinned top banner — overdue (warning tone)
        </div>
        <IssueMonitorBanner issue={overdueMonitorIssue} onCheckNow={() => undefined} />

        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Pinned top banner — cleared / none (renders nothing)
        </div>
        <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          (banner + strip hide entirely for cleared / no-monitor issues)
        </div>
        <IssueMonitorBanner issue={clearedIssue} onCheckNow={() => undefined} />
        <IssueMonitorBanner issue={baseIssue} onCheckNow={() => undefined} />
      </section>

      <section className="space-y-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Composer strip — scheduled (inline, above the reply composer)
        </div>
        <IssueMonitorComposerStrip
          issue={scheduledMonitorIssue}
          onCheckNow={() => undefined}
        />

        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Composer strip — overdue
        </div>
        <IssueMonitorComposerStrip issue={overdueMonitorIssue} onCheckNow={() => undefined} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Monitor row - Not scheduled (default state)
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={baseIssue}
              onUpdate={() => undefined}
              inline
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Monitor row - Scheduled (Greptile, in 5m)
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={monitoredIssue}
              onUpdate={() => undefined}
              inline
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Monitor row - Triggered recently
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={triggeredIssue}
              onUpdate={() => undefined}
              inline
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            IssueProperties Monitor row - Cleared
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <IssueProperties
              issue={clearedIssue}
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
  title: "Product/Issue Monitor surfaces",
  component: MonitorSurfaceStories,
  parameters: {
    docs: {
      description: {
        component:
          "Surfaces the pinned monitor banner, composer strip, and IssueProperties Monitor row across the wireframe-04 states (scheduled / retrying / due / overdue / cleared) for UX review.",
      },
    },
  },
} satisfies Meta<typeof MonitorSurfaceStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const MonitorSurfaces: Story = {};
