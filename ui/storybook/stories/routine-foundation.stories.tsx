import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RoutineDetail, RoutineRunSummary } from "@paperclipai/shared";
import { RoutineContextualSidebar } from "@/components/RoutineContextualSidebar";
import { RoutineOverview } from "@/components/RoutineOverview";
import {
  RoutineDetailContext,
  type RoutineDetailContextValue,
} from "@/components/routine-sections/context";

const referenceTime = new Date("2026-08-31T16:00:00.000Z");

const recentRun: RoutineRunSummary = {
  id: "run-release-review",
  companyId: "company-storybook",
  routineId: "routine-release-review",
  triggerId: "trigger-weekday",
  source: "schedule",
  status: "succeeded",
  triggeredAt: referenceTime,
  idempotencyKey: null,
  triggerPayload: null,
  dispatchFingerprint: null,
  linkedIssueId: "task-release-digest",
  coalescedIntoRunId: null,
  failureReason: null,
  completedAt: new Date("2026-08-31T16:08:00.000Z"),
  createdAt: referenceTime,
  updatedAt: new Date("2026-08-31T16:08:00.000Z"),
  trigger: { id: "trigger-weekday", kind: "schedule", label: "Weekday review" },
  linkedIssue: {
    id: "task-release-digest",
    identifier: "PAP-418",
    title: "Prepare the release readiness digest",
    status: "done",
    priority: "high",
    updatedAt: new Date("2026-08-31T16:08:00.000Z"),
  },
};

function routineFixture(state: "active" | "draft"): RoutineDetail {
  return {
    id: "routine-release-review",
    companyId: "company-storybook",
    projectId: "project-storybook",
    folderId: null,
    goalId: null,
    parentIssueId: null,
    title: "Weekly release review",
    description:
      "Review open release blockers, summarize readiness, and hand a concise recommendation to the operator.",
    assigneeAgentId: state === "active" ? "agent-release-manager" : null,
    priority: "high",
    status: state === "active" ? "active" : "paused",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    env: null,
    latestRevisionId: "revision-7",
    latestRevisionNumber: 7,
    createdByAgentId: null,
    createdByUserId: "user-product",
    responsibleUserId: "user-product",
    updatedByAgentId: null,
    updatedByUserId: "user-product",
    lastTriggeredAt: state === "active" ? referenceTime : null,
    lastEnqueuedAt: state === "active" ? referenceTime : null,
    createdAt: new Date("2026-07-01T16:00:00.000Z"),
    updatedAt: referenceTime,
    project: {
      id: "project-storybook",
      name: "Paperclip release",
      description: null,
      status: "in_progress",
    },
    assignee: state === "active" ? {
      id: "agent-release-manager",
      name: "Release Manager",
      role: "manager",
      title: "Release Manager",
      urlKey: "release-manager",
    } : null,
    parentIssue: null,
    triggers: [{
      id: "trigger-weekday",
      companyId: "company-storybook",
      routineId: "routine-release-review",
      kind: "schedule",
      label: "Weekday review",
      enabled: state === "active",
      cronExpression: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
      nextRunAt: state === "active" ? new Date("2026-09-01T16:00:00.000Z") : null,
      lastFiredAt: state === "active" ? referenceTime : null,
      publicId: null,
      secretId: null,
      signingMode: null,
      replayWindowSec: null,
      lastRotatedAt: null,
      lastResult: state === "active" ? "succeeded" : null,
      createdByAgentId: null,
      createdByUserId: "user-product",
      updatedByAgentId: null,
      updatedByUserId: "user-product",
      createdAt: new Date("2026-07-01T16:00:00.000Z"),
      updatedAt: referenceTime,
    }],
    recentRuns: state === "active" ? [recentRun] : [],
    activeIssue: null,
  };
}

function contextFixture(state: "active" | "draft"): RoutineDetailContextValue {
  const routine = routineFixture(state);
  return {
    routine,
    routineId: routine.id,
    companyId: routine.companyId,
    routineRuns: routine.recentRuns,
    currentAssignee: routine.assignee,
    hasLiveRun: false,
  } as RoutineDetailContextValue;
}

function RoutineFoundationFixture({ state = "active" }: { state?: "active" | "draft" }) {
  const context = contextFixture(state);
  return (
    <RoutineDetailContext.Provider value={context}>
      <div className="flex min-h-(--sz-85dvh) overflow-hidden border border-border bg-background">
        <div className="w-64 shrink-0">
          <RoutineContextualSidebar
            routineId={context.routine.id}
            title={context.routine.title}
          />
        </div>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold">{context.routine.title}</h1>
                <p className="text-sm text-muted-foreground">Overview</p>
              </div>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Edit routine
              </button>
            </div>
            <RoutineOverview />
          </div>
        </main>
      </div>
    </RoutineDetailContext.Provider>
  );
}

const meta = {
  title: "Product/Routines/Foundation",
  component: RoutineFoundationFixture,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Routine detail uses contextual navigation, a read-first Overview, canonical task rows for recent runs, and scoped Audit destinations.",
      },
    },
  },
} satisfies Meta<typeof RoutineFoundationFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveOverview: Story = {};

export const DraftOverview: Story = {
  args: { state: "draft" },
};
