import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue } from "@paperclipai/shared";
import { IssueMonitorActivityCard } from "@/components/IssueMonitorActivityCard";
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

const longerWaitIssue: Issue = {
  ...baseIssue,
  monitorNextCheckAt: inTwoHours(),
  monitorNotes: null,
  monitorAttemptCount: 0,
  executionPolicy: {
    ...(baseIssue.executionPolicy ?? { mode: "normal", commentRequired: true, stages: [] }),
    monitor: {
      nextCheckAt: inTwoHours().toISOString(),
      notes: null,
      kind: null,
      scheduledBy: "assignee",
      serviceName: null,
      externalRef: null,
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

function MonitorSurfaceStories() {
  return (
    <div className="space-y-8 p-6">
      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          IssueMonitorActivityCard - external service (Greptile)
        </div>
        <IssueMonitorActivityCard
          issue={monitoredIssue}
          onCheckNow={() => undefined}
          checkingNow={false}
        />
      </section>

      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          IssueMonitorActivityCard - generic 2h wait, no service metadata
        </div>
        <IssueMonitorActivityCard
          issue={longerWaitIssue}
          onCheckNow={() => undefined}
          checkingNow={false}
        />
      </section>

      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          IssueMonitorActivityCard - returns null when no monitor is set
        </div>
        <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          (intentionally renders nothing for issues without a scheduled monitor)
        </div>
        <IssueMonitorActivityCard issue={baseIssue} onCheckNow={() => undefined} />
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
          "Surfaces the IssueMonitorActivityCard and IssueProperties Monitor row in scheduled / not-scheduled / external-service variants for UX review.",
      },
    },
  },
} satisfies Meta<typeof MonitorSurfaceStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const MonitorSurfaces: Story = {};
