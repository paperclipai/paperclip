import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ActivityEvent, Issue, RoutineDetail as RoutineDetailData, RoutineRunSummary, RoutineTrigger } from "@paperclipai/shared";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { routinesApi } from "@/api/routines";
import { issuesApi } from "@/api/issues";
import { foldersApi } from "@/api/folders";
import { Layout } from "@/components/Layout";
import { RoutineDetail } from "@/pages/RoutineDetail";
import { Routines } from "@/pages/Routines";
import { Route, Routes, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { storybookAgents, storybookIssues } from "./paperclipData";

const now = new Date("2026-09-18T15:00:00Z");
const routineId = "routine-webhook-story";
const companyId = "company-storybook";
const defaultWebhookUrl = "https://acme.paperclip.example/api/routine-triggers/public/0123456789abcdef01234567/fire";
const demoSecret = "storybook-demo-secret-not-a-real-credential";
const actorFields = {
  createdByAgentId: null, createdByUserId: null,
  updatedByAgentId: null, updatedByUserId: null,
  createdAt: now, updatedAt: now,
};

export function webhook(signingMode: string, index = 1, webhookUrl = defaultWebhookUrl): RoutineTrigger {
  return {
    ...actorFields, id: `webhook-${index}`, companyId, routineId,
    kind: "webhook", label: "Deployment completed", enabled: true,
    cronExpression: null, timezone: null, nextRunAt: null,
    lastFiredAt: now, publicId: "0123456789abcdef01234567", webhookUrl,
    secretId: "storybook-webhook-secret", signingMode,
    replayWindowSec: signingMode === "hmac_sha256" ? 300 : null,
    lastRotatedAt: null, lastResult: "issue_created",
    lastWebhookDelivery: { status: "received", receivedAt: now.toISOString(), test: false },
  };
}

const completedRun: RoutineRunSummary = {
  id: "storybook-webhook-run", companyId, routineId, triggerId: "webhook-1",
  source: "webhook", status: "completed", triggeredAt: now, completedAt: now,
  createdAt: now, updatedAt: now, idempotencyKey: "deployment-123",
  triggerPayload: { event: "deployment", environment: "production" },
  dispatchFingerprint: null, linkedIssueId: "storybook-task", coalescedIntoRunId: null,
  failureReason: null, trigger: { id: "webhook-1", kind: "webhook", label: "Deployment completed" },
  linkedIssue: {
    id: "storybook-task", identifier: "PAP-123", title: "Verify the production deployment",
    status: "done", priority: "medium", updatedAt: now,
  },
};

export const baseRoutine: RoutineDetailData = {
  ...actorFields, id: routineId, companyId, projectId: null, goalId: null,
  parentIssueId: null, responsibleUserId: null,
  title: "Verify a deployment",
  description: "Check the deployment from the incoming webhook. Verify the service is healthy and report the result.",
  assigneeAgentId: storybookAgents[0]?.id ?? null, priority: "medium", status: "active",
  concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed",
  activityGatePolicy: "always", activityGateScope: "company", variables: [], env: null,
  latestRevisionId: "revision-1", latestRevisionNumber: 1,
  lastTriggeredAt: now, lastEnqueuedAt: null, managedByPlugin: null,
  project: null, assignee: null, parentIssue: null, activeIssue: null,
  triggers: [], recentRuns: [completedRun],
};

const executionIssues: Issue[] = [
  { title: "Verify production deployment v2.8.4", status: "in_progress", priority: "high" },
  { title: "Verify staging deployment v2.8.4", status: "in_review", priority: "medium" },
  { title: "Verify production deployment v2.8.3", status: "done", priority: "medium" },
  { title: "Verify rollback health checks", status: "blocked", priority: "high" },
].map((entry, index) => ({
  ...storybookIssues[0], ...entry,
  id: `routine-execution-${index}`, identifier: `PAP-${123 + index}`, issueNumber: 123 + index,
  companyId, originKind: "routine_execution", originId: routineId,
  originRunId: `routine-run-${index}`, projectId: null, parentId: null,
  assigneeAgentId: storybookAgents[0].id,
  executionRunId: null, checkoutRunId: null, executionLockedAt: null,
  labels: [], labelIds: [], blockedBy: [],
  createdAt: new Date(now.getTime() - index * 3_600_000),
  updatedAt: new Date(now.getTime() - index * 3_600_000),
  lastActivityAt: new Date(now.getTime() - index * 3_600_000),
  lastExternalCommentAt: null,
})) as Issue[];

const routineActivity: ActivityEvent[] = [
  { action: "routine.run_triggered", entityType: "routine_run", details: { source: "webhook", status: "issue_created", issueIdentifier: "PAP-123" } },
  { action: "routine.trigger_updated", entityType: "routine_trigger", details: { label: "Deployment completed", signingMode: "bearer" } },
  { action: "routine.updated", entityType: "routine", details: { title: "Verify a deployment", changedFields: ["description"] } },
  { action: "routine.trigger_created", entityType: "routine_trigger", details: { kind: "webhook", label: "Deployment completed" } },
].map((event, index) => ({
  ...event, id: `routine-activity-${index}`, companyId, entityId: routineId,
  actorType: "user", actorId: "user-board", agentId: null, runId: null,
  createdAt: new Date(now.getTime() - index * 3_600_000),
}));

type Props = {
  preview?: ReactNode;
  webhookUrl?: string;
  signingMode: "app_webhook" | "fireflies_hmac" | "bearer" | "hmac_sha256" | "github_hmac" | "none";
  state: "setup" | "credentials" | "configured" | "failure" | "overview" | "list" | "runs" | "activity";
};

/** The actual application shell and route pages, backed by an in-memory API. */
export function WebhookReview({ signingMode = "bearer", state = "configured", preview, webhookUrl = defaultWebhookUrl }: Props) {
  const navigate = useNavigate();
  const { setSelectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  const initialActions = useRef({ navigate, setSelectedCompanyId });

  useEffect(() => {
    const fresh = state === "setup" || state === "credentials";
    let routine: RoutineDetailData = {
      ...baseRoutine,
      lastTriggeredAt: fresh ? null : now,
      recentRuns: fresh ? [] : [completedRun],
      triggers: fresh ? [] : [{
        ...webhook(signingMode, 1, webhookUrl),
        lastWebhookDelivery: { status: state === "failure" ? "rejected" : "received", receivedAt: now.toISOString(), test: false },
        lastResult: state === "failure"
          ? "Failed to create task: no default agent assigned"
          : webhook(signingMode).lastResult,
      }],
    };
    const originalApi = { ...routinesApi };
    const originalFoldersList = foldersApi.list;
    const originalIssuesList = issuesApi.list;
    const originalIssueUpdate = issuesApi.update;
    const originalCompactList = issuesApi.listCompact;
    let issues = executionIssues.map((issue) => ({ ...issue }));
    issuesApi.list = async (id, filters) => {
      if (id !== companyId || filters?.originId !== routineId) return originalIssuesList(id, filters);
      const search = filters.q?.toLowerCase();
      return issues.filter((issue) => !search || `${issue.identifier} ${issue.title}`.toLowerCase().includes(search));
    };
    issuesApi.listCompact = async (id, filters, options) => {
      if (id !== companyId || filters?.originId !== routineId) return originalCompactList(id, filters, options);
      const rows = await issuesApi.list(id, filters);
      return rows.filter((issue) => !filters.status || filters.status.split(",").includes(issue.status))
        .map((issue) => ({ ...issue, activeRecoveryAction: null, successfulRunHandoff: null }));
    };
    issuesApi.update = async (id, patch) => {
      const issue = { ...issues.find((item) => item.id === id)!, ...patch };
      issues = issues.map((item) => item.id === id ? issue : item);
      return { ...issue, changes: {} };
    };
    routinesApi.get = async () => ({ ...routine, triggers: routine.triggers.filter((trigger) => !trigger.archived) });
    routinesApi.list = async () => [{ ...routine, lastRun: routine.recentRuns[0] ?? null }];
    routinesApi.listRuns = async () => routine.recentRuns;
    routinesApi.activity = async () => fresh ? [] : routineActivity;
    routinesApi.listRevisions = async () => [];
    routinesApi.update = async (_id, patch) => (routine = { ...routine, ...patch });
    routinesApi.createTrigger = async (_id, input) => {
      const trigger: RoutineTrigger = {
        ...webhook(String(input.signingMode ?? "bearer"), routine.triggers.length + 1, webhookUrl), ...input,
        lastFiredAt: null, lastResult: null,
      };
      routine = { ...routine, triggers: [...routine.triggers, trigger] };
      return { trigger, secretMaterial: trigger.kind === "webhook" ? { webhookUrl, webhookSecret: demoSecret } : null };
    };
    routinesApi.updateTrigger = async (id, patch) => {
      const trigger = { ...routine.triggers.find((item) => item.id === id)!, ...patch };
      routine = { ...routine, triggers: routine.triggers.map((item) => item.id === id ? trigger : item) };
      return trigger;
    };
    routinesApi.deleteTrigger = async (id) => {
      routine = { ...routine, triggers: routine.triggers.filter((item) => item.id !== id) };
    };
    routinesApi.rotateTriggerSecret = async (id) => ({
      trigger: routine.triggers.find((item) => item.id === id)!,
      secretMaterial: { webhookUrl, webhookSecret: `${demoSecret}-rotated` },
    });
    foldersApi.list = async (_companyId, kind) => ({ kind, folders: [], allCount: 1, unfiledCount: 1 });
    const previousFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      // Keep unrelated page actions inside the review fixture as well.
      if (url.pathname.startsWith("/api/") && method !== "GET") {
        return Response.json({ error: "This action is outside the webhook review fixture." }, { status: 422 });
      }
      return previousFetch(input, init);
    };
    initialActions.current.setSelectedCompanyId(companyId);
    initialActions.current.navigate(state === "list" ? "/PAP/routines" : `/PAP/routines/${routineId}/${["overview", "runs", "activity"].includes(state) ? state : "triggers"}`, { replace: true });
    setReady(true);
    return () => {
      Object.assign(routinesApi, originalApi);
      foldersApi.list = originalFoldersList;
      issuesApi.list = originalIssuesList;
      issuesApi.update = originalIssueUpdate;
      issuesApi.listCompact = originalCompactList;
      window.fetch = previousFetch;
    };
  }, [signingMode, state, webhookUrl]);

  if (!ready) return null;
  return (
    <PluginLauncherProvider>
    <Routes>
      <Route path="/:companyPrefix" element={<Layout />}>
        <Route path="routines" element={<Routines />} />
        <Route path="routines/:routineId/:section?" element={preview ?? <RoutineDetail />} />
      </Route>
    </Routes>
    </PluginLauncherProvider>
  );
}
