import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RoutineTrigger } from "@paperclipai/shared";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { FlyoutAppearanceProvider } from "@/components/ui/flyout-appearance";
import { RoutineHistoryTab } from "@/components/RoutineHistoryTab";
import { RoutineRunVariablesDialog } from "@/components/RoutineRunVariablesDialog";
import { RoutineEditDialog, type RoutineEditDialogProps } from "@/components/routine-page/RoutineEditDialog";
import { RoutinePage, RoutinePageActions, RoutineSubpage } from "@/components/routine-page/RoutinePage";
import { RoutineWebhookDialog } from "@/components/routine-page/RoutineWebhookDialog";
import { routineToDraft } from "@/components/routine-page/routine-form";
import { routineAutomationState } from "@/components/routine-page/routine-summary";
import { queryKeys } from "@/lib/queryKeys";
import { RoutineAuditActivity } from "@/pages/audit/RoutineAuditActivity";
import { createIssue, storybookAgents, storybookProjects, storybookSecrets } from "../../fixtures/paperclipData";
import { installFixtureApi } from "../capability-gaps/api";
import { composerSkills } from "../composerSkills";
import { DesignProposalAccess } from "../design-proposals/DesignProposalAccess";
import {
  DEMO_WEBHOOK_KEY,
  HISTORY_PAGE_SIZE,
  ROUTINE_ID,
  olderHistory,
  routineAuditEvents,
  routinePeople,
  routineResponsibilities,
  routineRevisions,
  routineScenarios,
  webhookTrigger,
  type RoutineScenario,
  type RoutineScenarioKey,
} from "./routine-page-data";
import { recentTasks } from "../design-proposals/task-page-data";

/** Fixture stand-in for a webhook's test mode: the test event "arrives" a moment after testing starts. */
function useWebhookTest(update: (id: string, change: Partial<RoutineTrigger>) => void) {
  const [test, setTest] = useState<{ id: string; before: RoutineTrigger["lastWebhookDelivery"] } | null>(null);
  const timer = useRef<number | null>(null);
  const finish = () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (test) update(test.id, { setupPending: false, lastWebhookDelivery: test.before ?? null });
    setTest(null);
  };
  const start = (trigger: RoutineTrigger) => {
    setTest({ id: trigger.id, before: trigger.lastWebhookDelivery });
    update(trigger.id, { setupPending: true, lastWebhookDelivery: null });
    timer.current = window.setTimeout(
      () => update(trigger.id, { lastWebhookDelivery: { status: "received", receivedAt: new Date().toISOString(), test: true } }),
      2500,
    );
  };
  return { testingId: test?.id ?? null, start, finish };
}

const COMPANY_ID = "company-storybook";

export type RoutinePagePreviewProps = {
  scenario?: RoutineScenarioKey;
  /** Open a dialog on load so its state can be reviewed in place. */
  initialDialog?: "edit" | "webhook" | "edit-webhook" | "run" | null;
  /** Where the "…" menu leads. */
  initialView?: "routine" | "versions" | "audit";
  menuOpen?: boolean;
  /** Areas of responsibility (experimental): "off" hides the field, as when the feature is disabled. */
  responsibility?: "off" | "none" | "direct" | "project" | "both";
  /** Render without the desktop shell, for phone-width review. */
  shell?: boolean;
};

/** Seeds what the shipped editor, version history and audit feed read: skills and routines for
 * the "/" menu, revisions, and routine activity. */
export function RoutineProposalFixtures({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    client.setQueryData(queryKeys.companySkills.list(COMPANY_ID), composerSkills);
    client.setQueryData(
      queryKeys.routines.list(COMPANY_ID),
      Object.values(routineScenarios).slice(0, 4).map((scenario, index) => ({ ...scenario.routine, id: `routine-${index}` })),
    );
    client.setQueryData(queryKeys.routines.revisions(ROUTINE_ID), routineRevisions);
    client.setQueryData([...queryKeys.routines.activity(COMPANY_ID, ROUTINE_ID), "audit"], routineAuditEvents);
    // Run now's workspace picker lists reusable workspaces; none in these fixtures.
    const fixtures = installFixtureApi([{ path: `/api/companies/${COMPANY_ID}/execution-workspaces`, read: () => [] }]);
    setReady(true);
    return () => fixtures.cleanup();
  }, [client]);
  return ready ? children : null;
}

export function RoutinePagePreview(props: RoutinePagePreviewProps) {
  return (
    <DesignProposalAccess>
      <RoutineProposalFixtures><RoutinePageContent {...props} /></RoutineProposalFixtures>
    </DesignProposalAccess>
  );
}

/** Fixture controller only: every change stays in local state so the page can be clicked through. */
function RoutinePageContent({
  scenario = "scheduled",
  initialDialog = null,
  initialView = "routine",
  menuOpen = false,
  responsibility = "off",
  shell = true,
}: RoutinePagePreviewProps) {
  const source: RoutineScenario = routineScenarios[scenario];
  const paged = scenario === "longHistory";
  const [routine, setRoutine] = useState(source.routine);
  const [history, setHistory] = useState(source.history);
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [view, setView] = useState(initialView);
  const [editOpen, setEditOpen] = useState(initialDialog === "edit" || initialDialog === "edit-webhook");
  const [webhookOpen, setWebhookOpen] = useState(initialDialog === "webhook" || initialDialog === "edit-webhook");
  const [runOpen, setRunOpen] = useState(initialDialog === "run");
  const [webhookId, setWebhookId] = useState<string | null>(() =>
    initialDialog === "webhook" ? source.routine.triggers.find((trigger) => trigger.kind === "webhook")?.id ?? null : null,
  );
  const [webhookKey, setWebhookKey] = useState<string | null>(null);
  const [removedWebhooks, setRemovedWebhooks] = useState<RoutineTrigger[]>([]);
  const responsibilitiesOn = responsibility !== "off";
  const [responsibilityId, setResponsibilityId] = useState(
    responsibility === "direct" || responsibility === "both" ? routineResponsibilities[0]!.id : "",
  );
  const linked = routineResponsibilities.find((item) => item.id === responsibilityId);
  const throughProject = responsibility === "project" || responsibility === "both" || responsibilityId
    ? routineResponsibilities.find((item) => item.id !== responsibilityId && routine.projectId != null && item.projectIds.includes(routine.projectId))
    : undefined;
  const pageResponsibilities = responsibilitiesOn
    ? [
        ...(linked ? [{ ...linked, via: "direct" as const }] : []),
        ...(throughProject && (responsibility === "project" || responsibility === "both") ? [{ ...throughProject, via: "project" as const }] : []),
      ]
    : undefined;

  const agent = storybookAgents.find((candidate) => candidate.id === routine.assigneeAgentId) ?? null;
  const project = storybookProjects.find((candidate) => candidate.id === routine.projectId) ?? null;
  const responsibleUser = routinePeople.find((person) => person.id === routine.responsibleUserId) ?? null;
  const webhooks = routine.triggers.filter((trigger) => trigger.kind === "webhook");
  const openWebhook = routine.triggers.find((trigger) => trigger.id === webhookId) ?? null;
  const draft = useMemo(() => routineToDraft(routine, responsibilityId), [routine, responsibilityId]);
  const state = routineAutomationState(routine);

  const updateTrigger = (id: string, change: Partial<RoutineTrigger>) =>
    setRoutine((current) => ({
      ...current,
      triggers: current.triggers.map((trigger) => (trigger.id === id ? { ...trigger, ...change } : trigger)),
    }));
  const removeTrigger = (id: string) =>
    setRoutine((current) => ({ ...current, triggers: current.triggers.filter((trigger) => trigger.id !== id) }));
  /** Removed from the page itself: offered back with Undo under Repeats, as the routed page does. */
  const [pageRemoved, setPageRemoved] = useState<RoutineTrigger[]>([]);
  const removeFromPage = (trigger: RoutineTrigger) => {
    removeTrigger(trigger.id);
    setPageRemoved((current) => [...current, trigger]);
  };
  const webhookTest = useWebhookTest(updateTrigger);
  const showWebhook = (trigger: RoutineTrigger | null) => {
    setWebhookId(trigger?.id ?? null);
    setWebhookKey(null);
    setWebhookOpen(true);
  };

  const webhookDialog = (
    <RoutineWebhookDialog
      open={webhookOpen}
      onOpenChange={(open) => {
        if (open) return;
        if (webhookTest.testingId) webhookTest.finish();
        else if (openWebhook?.setupPending) updateTrigger(openWebhook.id, { setupPending: false });
        setWebhookOpen(false);
      }}
      testing={webhookTest.testingId === openWebhook?.id}
      onStartTest={() => openWebhook && webhookTest.start(openWebhook)}
      onFinishTest={webhookTest.finish}
      routineTitle={routine.title}
      routineActive={state === "active"}
      trigger={openWebhook}
      secret={webhookKey}
      onCreate={(sender) => {
        const id = `webhook-${Date.now()}`;
        setRoutine((current) => ({
          ...current,
          triggers: [
            ...current.triggers,
            webhookTrigger({
              id,
              signingMode: sender === "github" ? "github_hmac" : "app_webhook",
              setupPending: true,
              lastWebhookDelivery: null,
            }),
          ],
        }));
        setWebhookId(id);
        setWebhookKey(DEMO_WEBHOOK_KEY);
      }}
      onReplaceKey={() => setWebhookKey(DEMO_WEBHOOK_KEY)}
      onSetPaused={(paused) => openWebhook && updateTrigger(openWebhook.id, { enabled: !paused })}
      onRemove={() => {
        if (openWebhook && editOpen) {
          removeTrigger(openWebhook.id);
          setRemovedWebhooks((current) => [...current, openWebhook]);
        } else if (openWebhook) removeFromPage(openWebhook);
        setWebhookOpen(false);
      }}
    />
  );

  const actions = view === "routine" ? (
    <RoutinePageActions
      archived={state === "archived"}
      defaultMenuOpen={menuOpen}
      onEdit={() => setEditOpen(true)}
      onRunNow={() => setRunOpen(true)}
      onOpenVersionHistory={() => setView("versions")}
      onOpenAuditLog={() => setView("audit")}
      onArchive={() => setRoutine((current) => ({ ...current, status: "archived" }))}
      onRestore={() => setRoutine((current) => ({ ...current, status: "paused" }))}
    />
  ) : null;

  const page = view === "routine" ? (
    <RoutinePage
      routine={routine}
      agent={agent}
      project={project}
      responsibleUser={responsibleUser}
      responsibilities={pageResponsibilities}
      history={paged ? [...history, ...olderHistory].slice(0, pagesLoaded * HISTORY_PAGE_SIZE) : history}
      hasMoreHistory={paged && pagesLoaded * HISTORY_PAGE_SIZE < history.length + olderHistory.length}
      loadingMoreHistory={loadingMore}
      onLoadMoreHistory={() => {
        setLoadingMore(true);
        window.setTimeout(() => {
          setPagesLoaded((count) => count + 1);
          setLoadingMore(false);
        }, 500);
      }}
      skippedRunCount={source.skippedRunCount}
      instructionCommentCount={source.instructionCommentCount}
      onToggleActive={(active) => setRoutine((current) => ({ ...current, status: active ? "active" : "paused" }))}
      onEdit={() => setEditOpen(true)}
      onSaveSchedule={(id, change) => updateTrigger(id, { ...change, nextRunAt: new Date(Date.now() + 3 * 3_600_000) })}
      onRemoveSchedule={(id) => {
        const trigger = routine.triggers.find((item) => item.id === id);
        if (trigger) removeFromPage(trigger);
      }}
      onSetTriggerPaused={(id, paused) => updateTrigger(id, { enabled: !paused })}
      onRemoveTrigger={removeFromPage}
      removedTriggers={pageRemoved}
      onRestoreTrigger={(trigger) => {
        setPageRemoved((current) => current.filter((item) => item.id !== trigger.id));
        setRoutine((current) => ({ ...current, triggers: [...current.triggers, trigger] }));
      }}
      onOpenWebhook={showWebhook}
    />
  ) : (
    <RoutineSubpage
      routineTitle={routine.title}
      title={view === "versions" ? "Version history" : "Audit log"}
      onBack={() => setView("routine")}
    >
      {view === "versions" ? (
        <RoutineHistoryTab
          routine={routine}
          isEditDirty={false}
          dirtyFields={[]}
          onDiscardEdits={() => {}}
          onSaveEdits={() => {}}
          agents={new Map(storybookAgents.map((candidate) => [candidate.id, candidate]))}
          projects={new Map(storybookProjects.map((candidate) => [candidate.id, candidate]))}
          secrets={storybookSecrets}
          onRestoreSecretMaterials={() => {}}
        />
      ) : (
        <RoutineAuditActivity companyId={routine.companyId} routineId={routine.id} />
      )}
    </RoutineSubpage>
  );

  return (
    <>
      {shell ? (
        <DesignPageShell
          title="Routines"
          headerActions={actions ? <FlyoutAppearanceProvider appearance="default">{actions}</FlyoutAppearanceProvider> : null}
          sidebar={<DesignSidebar recentTasks={recentTasks.map((item) => item.issue)} onNewTask={() => {}} />}
        >
          {/* The frame opts its own menus into the proposed flyout style; the routine page ships with the app's standard one. */}
          <FlyoutAppearanceProvider appearance="default">{page}</FlyoutAppearanceProvider>
        </DesignPageShell>
      ) : (
        <div className="min-h-dvh bg-background text-foreground">
          <header className="flex h-12 items-center justify-between gap-2 border-b border-border px-4">
            <span className="text-sm font-medium">Routines</span>
            {actions}
          </header>
          {page}
        </div>
      )}

      <RoutineEditDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setRemovedWebhooks([]);
        }}
        initial={draft}
        agents={storybookAgents}
        projects={storybookProjects}
        people={routinePeople}
        secrets={storybookSecrets}
        responsibilities={
          responsibilitiesOn
            ? routineResponsibilities.map((item) => ({
                ...item,
                projectIds: responsibility === "project" || responsibility === "both" ? item.projectIds : [],
              }))
            : undefined
        }
        canChangeResponsibleUser={routine.canChangeResponsibleUser}
        webhooks={webhooks}
        onOpenWebhook={showWebhook}
        onRemoveWebhook={(trigger) => {
          removeTrigger(trigger.id);
          setRemovedWebhooks((current) => [...current, trigger]);
        }}
        removedWebhooks={removedWebhooks}
        onRestoreWebhook={(trigger) => {
          setRemovedWebhooks((current) => current.filter((item) => item.id !== trigger.id));
          setRoutine((current) => ({ ...current, triggers: [...current.triggers, trigger] }));
        }}
        onCreateSecret={async (name) => ({ ...storybookSecrets[0]!, id: `secret-${name}`, name, key: name.toLowerCase() })}
        onSave={(next) => {
          setResponsibilityId(next.responsibilityId);
          setRoutine((current) => {
            const others = current.triggers.filter((trigger) => trigger.kind !== "schedule");
            const existing = current.triggers.find((trigger) => trigger.kind === "schedule");
            const schedules = next.schedule
              ? [{
                  ...(existing ?? routineScenarios.scheduled.routine.triggers[0]!),
                  ...next.schedule,
                  nextRunAt: new Date(Date.now() + 3 * 3_600_000),
                }]
              : [];
            return {
              ...current,
              title: next.title,
              description: next.description,
              projectId: next.projectId || null,
              assigneeAgentId: next.assigneeAgentId || null,
              responsibleUserId: next.responsibleUserId || null,
              variables: next.variables,
              env: next.env,
              triggers: [...schedules, ...others],
            };
          });
          setEditOpen(false);
        }}
      >
        {editOpen ? webhookDialog : null}
      </RoutineEditDialog>

      {editOpen ? null : webhookDialog}

      <RoutineRunVariablesDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        companyId={routine.companyId}
        routineName={routine.title}
        agents={storybookAgents}
        projects={storybookProjects}
        defaultProjectId={routine.projectId}
        defaultAssigneeAgentId={routine.assigneeAgentId}
        variables={routine.variables}
        isPending={false}
        onSubmit={() => {
          setHistory((current) => [
            createIssue({
              id: `routine-task-new-${current.length}`,
              identifier: `PAP-${2141 + current.length}`,
              title: routine.title,
              status: "in_progress",
              originKind: "routine_execution",
              originId: routine.id,
              isUnreadForMe: false,
              updatedAt: new Date(),
            }),
            ...current,
          ]);
          setRunOpen(false);
        }}
      />
    </>
  );
}

/** The edit modal on its own with working webhooks: add, configure, pause, remove and undo all
 * change local state, so the flow can be clicked through without the page behind it. */
export function RoutineEditDialogPreview({
  initialWebhooks = [],
  ...props
}: Omit<RoutineEditDialogProps, "webhooks" | "onOpenWebhook" | "onRemoveWebhook" | "removedWebhooks" | "onRestoreWebhook" | "children"> & {
  initialWebhooks?: RoutineTrigger[];
}) {
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [removed, setRemoved] = useState<RoutineTrigger[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const open = webhooks.find((trigger) => trigger.id === openId) ?? null;
  const update = (id: string, change: Partial<RoutineTrigger>) =>
    setWebhooks((current) => current.map((trigger) => (trigger.id === id ? { ...trigger, ...change } : trigger)));
  const webhookTest = useWebhookTest(update);
  const remove = (trigger: RoutineTrigger) => {
    setWebhooks((current) => current.filter((item) => item.id !== trigger.id));
    setRemoved((current) => [...current, trigger]);
  };

  return (
    <RoutineEditDialog
      {...props}
      webhooks={webhooks}
      removedWebhooks={removed}
      onOpenWebhook={(trigger) => {
        setOpenId(trigger?.id ?? null);
        setKey(null);
        setDialogOpen(true);
      }}
      onRemoveWebhook={remove}
      onRestoreWebhook={(trigger) => {
        setRemoved((current) => current.filter((item) => item.id !== trigger.id));
        setWebhooks((current) => [...current, trigger]);
      }}
    >
      <RoutineWebhookDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (next) return;
          if (webhookTest.testingId) webhookTest.finish();
          else if (open?.setupPending) update(open.id, { setupPending: false });
          setDialogOpen(false);
        }}
        testing={webhookTest.testingId === open?.id}
        onStartTest={() => open && webhookTest.start(open)}
        onFinishTest={webhookTest.finish}
        routineTitle={props.initial.title}
        trigger={open}
        secret={key}
        onCreate={(sender) => {
          const id = `webhook-${Date.now()}`;
          setWebhooks((current) => [
            ...current,
            webhookTrigger({
              id,
              signingMode: sender === "github" ? "github_hmac" : "app_webhook",
              setupPending: true,
              lastWebhookDelivery: null,
            }),
          ]);
          setOpenId(id);
          setKey(DEMO_WEBHOOK_KEY);
        }}
        onReplaceKey={() => setKey(DEMO_WEBHOOK_KEY)}
        onSetPaused={(paused) => open && update(open.id, { enabled: !paused })}
        onRemove={() => {
          if (open) remove(open);
          setDialogOpen(false);
        }}
      />
    </RoutineEditDialog>
  );
}
