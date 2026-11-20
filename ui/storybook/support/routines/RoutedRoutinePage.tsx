import type { Issue, RoutineDetail as RoutineDetailData, RoutineTrigger } from "@paperclipai/shared";
import { Layout } from "@/components/Layout";
import { Route, Routes } from "@/lib/router";
import { RoutineDetail } from "@/pages/RoutineDetail";
import { Routines } from "@/pages/Routines";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { createIssue, storybookIssues } from "../../fixtures/paperclipData";
import { composerSkills } from "../composerSkills";
import type { FixtureRoute } from "../capability-gaps/api";
import {
  DEMO_WEBHOOK_KEY,
  ROUTINE_ID,
  olderHistory,
  routineAuditEvents,
  routinePeople,
  routineRevisions,
  routineScenarios,
  webhookTrigger,
  type RoutineScenarioKey,
} from "./routine-page-data";

const COMPANY_ID = "company-storybook";
const api = (path: string) => `/api${path}`;

/**
 * The routed routine page (`/routines/:routineId`, `/history`, `/activity`) in the
 * real app shell, as the board UI mounts it.
 */
export function RoutedRoutinePage() {
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="routines" element={<Routines />} />
          <Route path="routines/:routineId/:section?" element={<RoutineDetail />} />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}

/**
 * An in-memory routines API seeded from the same scenarios as the prop-driven
 * Routine page stories, so the routed page and the preview render the same
 * routine. History is served the way the page asks for it: `limit`/`offset`
 * over tasks created by the routine, newest first. Changes made on the page
 * (status, schedule, webhooks, Run now) update this state.
 */
export function routedRoutineFixtureRoutes(scenario: RoutineScenarioKey): FixtureRoute[] {
  const source = routineScenarios[scenario];
  let routine: RoutineDetailData = structuredClone(source.routine);
  let history: Issue[] = scenario === "longHistory" ? [...source.history, ...olderHistory] : [...source.history];
  let revision = routine.latestRevisionNumber ?? 1;

  const current = () => ({ ...routine, triggers: routine.triggers.filter((trigger) => !trigger.archived) });
  const nextRevision = () => {
    revision += 1;
    routine = { ...routine, latestRevisionId: `revision-${revision}`, latestRevisionNumber: revision };
  };
  const updateTrigger = (id: string, change: Partial<RoutineTrigger>) => {
    routine = {
      ...routine,
      triggers: routine.triggers.map((trigger) => (trigger.id === id ? { ...trigger, ...change } : trigger)),
    };
    return routine.triggers.find((trigger) => trigger.id === id)!;
  };

  return [
    { path: api(`/routines/${ROUTINE_ID}`), method: "GET", read: () => current() },
    {
      path: api(`/routines/${ROUTINE_ID}`),
      method: "PATCH",
      read: ({ body }) => {
        const { baseRevisionId: _base, ...patch } = body;
        routine = { ...routine, ...(patch as Partial<RoutineDetailData>) };
        nextRevision();
        return current();
      },
    },
    { path: api(`/routines/${ROUTINE_ID}/runs`), read: () => [] },
    { path: api(`/routines/${ROUTINE_ID}/revisions`), read: () => routineRevisions },
    {
      path: api(`/routines/${ROUTINE_ID}/run`),
      method: "POST",
      read: () => {
        const issue = createIssue({
          id: `routine-task-run-${history.length}`,
          identifier: `PAP-${2141 + history.length}`,
          title: routine.title,
          status: "todo",
          originKind: "routine_execution",
          originId: ROUTINE_ID,
          parentId: null,
          isUnreadForMe: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        history = [issue, ...history];
        return { id: `routine-run-${history.length}`, companyId: COMPANY_ID, routineId: ROUTINE_ID, status: "issue_created", linkedIssueId: issue.id };
      },
    },
    {
      path: api(`/routines/${ROUTINE_ID}/triggers`),
      method: "POST",
      read: ({ body }) => {
        const trigger = webhookTrigger({
          id: `webhook-created-${routine.triggers.length}`,
          signingMode: String(body.signingMode ?? "app_webhook"),
          setupPending: Boolean(body.setupPending),
          lastFiredAt: null,
          lastResult: null,
          lastWebhookDelivery: null,
        });
        routine = { ...routine, triggers: [...routine.triggers, trigger] };
        return { trigger, secretMaterial: { webhookUrl: trigger.webhookUrl, webhookSecret: DEMO_WEBHOOK_KEY } };
      },
    },
    {
      path: /^\/api\/routine-triggers\/[^/]+$/,
      method: "PATCH",
      read: ({ url, body }) => {
        const id = url.pathname.split("/").pop()!;
        const before = routine.triggers.find((trigger) => trigger.id === id);
        const change = { ...body } as Partial<RoutineTrigger>;
        // Mirrors the server: finishing test mode restores the last real delivery.
        if (body.setupPending === false && before?.lastWebhookDelivery?.test) {
          change.lastWebhookDelivery = before.lastWebhookDelivery.previous ?? null;
        }
        if (typeof body.cronExpression === "string") change.nextRunAt = new Date(Date.now() + 3 * 3_600_000);
        const trigger = updateTrigger(id, change);
        nextRevision();
        return trigger;
      },
    },
    {
      path: /^\/api\/routine-triggers\/[^/]+\/rotate-secret$/,
      method: "POST",
      read: ({ url }) => {
        const id = url.pathname.split("/").at(-2)!;
        const trigger = updateTrigger(id, { lastRotatedAt: new Date() });
        return { trigger, secretMaterial: { webhookUrl: trigger.webhookUrl, webhookSecret: DEMO_WEBHOOK_KEY } };
      },
    },
    {
      path: api(`/companies/${COMPANY_ID}/issues`),
      method: "GET",
      read: ({ url }) => {
        const params = url.searchParams;
        if (params.get("originKind") !== "routine_execution" || params.get("originId") !== ROUTINE_ID) return storybookIssues;
        const offset = Number(params.get("offset") ?? 0);
        const limit = Number(params.get("limit") ?? history.length);
        return history.slice(offset, offset + limit);
      },
    },
    {
      path: api(`/companies/${COMPANY_ID}/routines`),
      method: "GET",
      read: () => [{ ...current(), lastRun: null }],
    },
    {
      path: api(`/companies/${COMPANY_ID}/activity`),
      read: ({ url }) =>
        url.searchParams.get("entityType") === "routine" && url.searchParams.get("entityId") === ROUTINE_ID
          ? routineAuditEvents
          : [],
    },
    {
      path: api(`/companies/${COMPANY_ID}/user-directory`),
      read: () => ({
        users: routinePeople.map((person) => ({
          principalId: person.id,
          status: "active",
          user: { id: person.id, email: `${person.id}@paperclip.local`, name: person.name, image: null },
        })),
      }),
    },
    { path: api(`/companies/${COMPANY_ID}/skills`), read: () => composerSkills },
    { path: api(`/companies/${COMPANY_ID}/execution-workspaces`), read: () => [] },
  ];
}
