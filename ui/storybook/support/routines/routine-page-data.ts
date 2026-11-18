import type { Issue, RoutineDetail, RoutineTrigger, RoutineVariable } from "@paperclipai/shared";
import type { RoutinePerson } from "@/components/routine-page/RoutinePage";
import { ROUTINE_HISTORY_PAGE_SIZE } from "@/pages/RoutineDetail";
import { createIssue, storybookAgents, storybookProjects } from "../../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
export const ROUTINE_ID = "routine-weekly-digest";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

const actor = {
  createdByAgentId: null,
  createdByUserId: "user-board",
  updatedByAgentId: null,
  updatedByUserId: "user-board",
  createdAt: minutesAgo(60 * 24 * 40),
  updatedAt: minutesAgo(90),
};

export const routinePeople: RoutinePerson[] = [
  { id: "user-board", name: "Riley Board" },
  { id: "user-sam", name: "Sam Okafor" },
  { id: "user-ines", name: "Inés Marchetti" },
  { id: "user-jun", name: "Jun Takahashi" },
];

export const WEBHOOK_URL = "https://acme.paperclip.example/api/routine-triggers/public/0123456789abcdef01234567/fire";
export const DEMO_WEBHOOK_KEY = "storybook-demo-key-not-a-real-credential";

export function scheduleTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return {
    ...actor,
    id: "trigger-schedule",
    companyId: COMPANY_ID,
    routineId: ROUTINE_ID,
    kind: "schedule",
    label: null,
    enabled: true,
    cronExpression: "0 9 * * 1-5",
    timezone: "America/Chicago",
    nextRunAt: minutesFromNow(47),
    lastFiredAt: minutesAgo(60 * 23),
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: "issue_created",
    ...overrides,
  };
}

export function webhookTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return {
    ...actor,
    id: "trigger-webhook",
    companyId: COMPANY_ID,
    routineId: ROUTINE_ID,
    kind: "webhook",
    label: null,
    enabled: true,
    cronExpression: null,
    timezone: null,
    nextRunAt: null,
    lastFiredAt: minutesAgo(35),
    publicId: "0123456789abcdef01234567",
    webhookUrl: WEBHOOK_URL,
    secretId: "secret-webhook",
    signingMode: "app_webhook",
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: "issue_created",
    lastWebhookDelivery: { status: "received", receivedAt: minutesAgo(35).toISOString(), test: false },
    ...overrides,
  };
}

function simpleTrigger(kind: "heartbeat" | "api"): RoutineTrigger {
  return scheduleTrigger({ id: `trigger-${kind}`, kind, cronExpression: null, timezone: null, nextRunAt: null });
}

export const digestVariables: RoutineVariable[] = [
  { name: "customer_name", label: "Customer name", type: "text", defaultValue: "Acme", required: true, options: [] },
  { name: "deadline", label: "Deadline", type: "text", defaultValue: null, required: false, options: [] },
];

const digestInstructions = `Compile last week's shipped work into a short digest and send it to the product channel before the Monday planning meeting.

## What to include

- Every task that moved to done since the previous digest, grouped by project
- Anything still blocked, with the person or decision it is waiting on
- Budget spent against the monthly limit

## How to write it

Keep it to five bullets per project. Lead with what changed for customers, not what was merged. Link each bullet to its task.

If nothing shipped in a project, say so in one line rather than leaving it out.`;

export function makeRoutine(overrides: Partial<RoutineDetail> = {}): RoutineDetail {
  return {
    ...actor,
    id: ROUTINE_ID,
    companyId: COMPANY_ID,
    projectId: storybookProjects[0]!.id,
    goalId: null,
    parentIssueId: null,
    responsibleUserId: "user-board",
    canChangeResponsibleUser: true,
    title: "Send the weekly product digest",
    description: digestInstructions,
    assigneeAgentId: storybookAgents[0]!.id,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    activityGatePolicy: "always",
    activityGateScope: "company",
    variables: [],
    env: null,
    latestRevisionId: "revision-12",
    latestRevisionNumber: 12,
    lastTriggeredAt: minutesAgo(60 * 23),
    lastEnqueuedAt: null,
    managedByPlugin: null,
    project: null,
    assignee: null,
    parentIssue: null,
    activeIssue: null,
    triggers: [scheduleTrigger()],
    recentRuns: [],
    ...overrides,
  };
}

function historyIssue(index: number, title: string, status: Issue["status"], ageMinutes: number): Issue {
  return createIssue({
    id: `routine-task-${index}`,
    identifier: `PAP-${2140 - index}`,
    issueNumber: 2140 - index,
    title,
    status,
    priority: "medium",
    originKind: "routine_execution",
    originId: ROUTINE_ID,
    parentId: null,
    isUnreadForMe: false,
    createdAt: minutesAgo(ageMinutes + 12),
    updatedAt: minutesAgo(ageMinutes),
    lastActivityAt: minutesAgo(ageMinutes),
  });
}

const DAY = 60 * 24;

export const digestHistory: Issue[] = [
  historyIssue(0, "Weekly product digest · Nov 16", "in_progress", 4),
  historyIssue(1, "Weekly product digest · Nov 9", "done", DAY * 7),
  historyIssue(2, "Weekly product digest · Nov 2", "done", DAY * 14),
  historyIssue(3, "Weekly product digest · Oct 26", "blocked", DAY * 21),
  historyIssue(4, "Weekly product digest · Oct 19", "done", DAY * 28),
  historyIssue(5, "Weekly product digest · Oct 12", "cancelled", DAY * 35),
  historyIssue(6, "Weekly product digest · Oct 5", "done", DAY * 42),
];

export type RoutineScenario = {
  routine: RoutineDetail;
  history: Issue[];
  skippedRunCount?: number;
  instructionCommentCount?: number;
};

const secretRef = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" }) as never;

export const routineScenarios = {
  scheduled: { routine: makeRoutine(), history: digestHistory },
  variablesAndSecrets: {
    routine: makeRoutine({
      title: "Send the weekly digest to {{customer_name}}",
      description: `Compile last week's shipped work and email a digest to {{customer_name}} by {{deadline}}.\n\nKeep it to five bullets and link each one to its task.`,
      variables: digestVariables,
      env: { SENDGRID_API_KEY: secretRef("secret-openai"), CRM_TOKEN: secretRef("secret-github") },
    }),
    history: digestHistory.slice(0, 4),
  },
  webhookOnly: {
    routine: makeRoutine({
      title: "Verify a deployment",
      description: "Check the deployment from the incoming webhook. Verify the service is healthy and report the result.",
      triggers: [webhookTrigger({ label: "Deployment completed" })],
    }),
    history: [
      historyIssue(0, "Verify production deployment v2.8.4", "in_progress", 3),
      historyIssue(1, "Verify staging deployment v2.8.4", "in_review", 64),
      historyIssue(2, "Verify production deployment v2.8.3", "done", DAY),
    ],
  },
  scheduleAndWebhooks: {
    routine: makeRoutine({
      title: "Triage new bug reports",
      triggers: [
        scheduleTrigger({ cronExpression: "0 * * * *" }),
        webhookTrigger({ id: "webhook-gh", signingMode: "github_hmac", label: "paperclipai/paperclip" }),
        webhookTrigger({
          id: "webhook-rejected",
          label: "Sentry",
          lastWebhookDelivery: { status: "rejected", receivedAt: minutesAgo(12).toISOString(), test: false },
        }),
        webhookTrigger({ id: "webhook-setup", label: "Linear", setupPending: true, lastWebhookDelivery: null }),
        webhookTrigger({ id: "webhook-paused", label: "Zendesk", enabled: false }),
      ],
    }),
    history: digestHistory,
  },
  paused: {
    routine: makeRoutine({ status: "paused", triggers: [scheduleTrigger({ nextRunAt: null })] }),
    history: digestHistory.slice(1),
  },
  scheduleTriggerPaused: {
    routine: makeRoutine({ triggers: [scheduleTrigger({ enabled: false, nextRunAt: null })] }),
    history: digestHistory.slice(1),
  },
  draft: {
    routine: makeRoutine({ status: "paused", assigneeAgentId: null, triggers: [scheduleTrigger({ nextRunAt: null })] }),
    history: [],
  },
  manualOnly: {
    routine: makeRoutine({
      title: "Prepare a customer handoff",
      description: "Gather the account history and open tasks for the customer, then write a one-page handoff.",
      triggers: [],
      responsibleUserId: null,
      projectId: null,
    }),
    history: [],
  },
  firstRunPending: { routine: makeRoutine(), history: [] },
  noInstructions: { routine: makeRoutine({ description: null }), history: [] },
  standingCheck: {
    routine: makeRoutine({
      title: "Watch for stuck deploys",
      description: "Check the deploy queue. If a deploy has been waiting more than 20 minutes, say which one and why.",
      triggers: [simpleTrigger("heartbeat"), simpleTrigger("api")],
    }),
    history: [],
  },
  customRunRules: {
    routine: makeRoutine({
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "enqueue_missed_with_cap",
      activityGatePolicy: "require_external_activity",
      activityGateScope: "project",
    }),
    history: digestHistory,
    skippedRunCount: 3,
  },
  pluginManaged: {
    routine: makeRoutine({
      title: "Sync meeting notes",
      managedByPlugin: { pluginDisplayName: "Fireflies", resourceKey: "meeting-notes-sync" } as never,
      triggers: [webhookTrigger({ signingMode: "fireflies_hmac", label: "Transcript ready" })],
    }),
    history: digestHistory.slice(0, 3),
  },
  archived: {
    routine: makeRoutine({ status: "archived", triggers: [scheduleTrigger({ nextRunAt: null })] }),
    history: digestHistory.slice(1),
  },
  responsibleUserLocked: {
    routine: makeRoutine({ canChangeResponsibleUser: false, responsibleUserId: "user-sam" }),
    history: digestHistory,
  },
  pausedWebhook: {
    routine: makeRoutine({
      title: "Verify a deployment",
      description: "Check the deployment from the incoming webhook. Verify the service is healthy and report the result.",
      status: "paused",
      triggers: [webhookTrigger({ label: "Deployment completed" })],
    }),
    history: digestHistory.slice(1, 4),
  },
  pausedScheduleAndWebhook: {
    routine: makeRoutine({
      status: "paused",
      triggers: [scheduleTrigger({ nextRunAt: null }), webhookTrigger({ label: "Deployment completed" })],
    }),
    history: digestHistory.slice(1),
  },
  longHistory: { routine: makeRoutine(), history: digestHistory },
  commentedInstructions: { routine: makeRoutine(), history: digestHistory, instructionCommentCount: 2 },
} satisfies Record<string, RoutineScenario>;

export type RoutineScenarioKey = keyof typeof routineScenarios;

/** Enough extra tasks to page through History. */
export const olderHistory: Issue[] = Array.from({ length: 33 }, (_, index) =>
  historyIssue(7 + index, `Weekly product digest · week ${40 - index}`, index % 9 === 4 ? "blocked" : "done", DAY * (49 + index * 7)),
);

/** The routed page's page size, so the preview pages History the same way. */
export const HISTORY_PAGE_SIZE = ROUTINE_HISTORY_PAGE_SIZE;

function revision(number: number, changeSummary: string, description: string, ageMinutes: number, cron = "0 9 * * 1-5") {
  const routine = makeRoutine({ description });
  return {
    id: `revision-${number}`,
    companyId: COMPANY_ID,
    routineId: ROUTINE_ID,
    revisionNumber: number,
    title: routine.title,
    description,
    snapshot: {
      version: 1,
      routine: {
        id: routine.id,
        companyId: routine.companyId,
        projectId: routine.projectId,
        goalId: null,
        parentIssueId: null,
        responsibleUserId: routine.responsibleUserId,
        title: routine.title,
        description,
        assigneeAgentId: routine.assigneeAgentId,
        priority: routine.priority,
        status: routine.status,
        concurrencyPolicy: routine.concurrencyPolicy,
        catchUpPolicy: routine.catchUpPolicy,
        activityGatePolicy: routine.activityGatePolicy,
        activityGateScope: routine.activityGateScope,
        variables: [],
        env: null,
      },
      triggers: [{ ...scheduleTrigger({ cronExpression: cron }) }],
    },
    changeSummary,
    restoredFromRevisionId: null,
    createdByAgentId: null,
    createdByUserId: "user-board",
    createdByRunId: null,
    createdAt: minutesAgo(ageMinutes),
  };
}

export const routineRevisions = [
  revision(12, "Updated the instructions", digestInstructions, 90),
  revision(11, "Changed the schedule", digestInstructions.replace("five bullets", "three bullets"), DAY * 3, "0 8 * * 1"),
  revision(10, "Created routine", "Compile last week's shipped work into a short digest.", DAY * 40, "0 8 * * 1"),
];

export const routineAuditEvents = [
  { action: "routine.run_triggered", details: { source: "schedule", status: "issue_created", issueIdentifier: "PAP-2140" } },
  { action: "routine.updated", details: { changeSummary: "Updated the instructions" } },
  { action: "routine.webhook_rejected", details: { label: "Sentry" } },
  { action: "routine.trigger_secret_rotated", details: { label: "Sentry" } },
  { action: "routine.trigger_updated", details: { changeSummary: "Changed the schedule to weekdays at 9:00 AM" } },
  { action: "routine.run_triggered", details: { source: "manual", status: "issue_created", issueIdentifier: "PAP-2139" } },
  { action: "routine.trigger_created", details: { kind: "webhook", label: "Sentry" } },
  { action: "routine.created", details: { title: "Send the weekly product digest" } },
].map((event, index) => ({
  ...event,
  id: `routine-audit-${index}`,
  companyId: COMPANY_ID,
  entityType: "routine",
  entityId: ROUTINE_ID,
  actorType: "user",
  actorId: "user-board",
  agentId: null,
  runId: null,
  createdAt: minutesAgo(4 + index * 60 * 9),
}));

/** Areas of responsibility (experimental). The first one has the Board UI project filed under it. */
export const routineResponsibilities = [
  { id: "responsibility-customers", title: "Keep customers informed", areaTitle: "Customer experience", projectIds: [] as string[] },
  { id: "responsibility-releases", title: "Ship reliable releases", areaTitle: "Engineering", projectIds: [storybookProjects[0]!.id] },
  { id: "responsibility-budget", title: "Hold the budget line", areaTitle: null, projectIds: [] as string[] },
];
