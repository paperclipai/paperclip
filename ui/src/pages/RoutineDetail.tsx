import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, RoutineDetail as RoutineDetailType, RoutineTrigger } from "@paperclipai/shared";
import { AlertCircle, Repeat } from "lucide-react";
import { ApiError } from "@/api/client";
import { documentAnnotationsApi } from "@/api/document-annotations";
import { describeError } from "@/api/errors";
import { issuesApi } from "@/api/issues";
import { responsibilitiesApi } from "@/api/responsibilities";
import { routinesApi, type RestoreRoutineRevisionResponse } from "@/api/routines";
import { EmptyState } from "@/components/EmptyState";
import { IssueDocumentAnnotations } from "@/components/IssueDocumentAnnotations";
import { PageSkeleton } from "@/components/PageSkeleton";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { RoutineHistoryTab } from "@/components/RoutineHistoryTab";
import { RoutineRunVariablesDialog, type RoutineRunDialogSubmitData } from "@/components/RoutineRunVariablesDialog";
import { RoutineEditDialog, type RoutineFormDraft } from "@/components/routine-page/RoutineEditDialog";
import {
  RoutinePage,
  RoutinePageActions,
  RoutineSubpage,
  type RoutinePageAgent,
  type RoutinePageProject,
} from "@/components/routine-page/RoutinePage";
import { RoutineWebhookDialog } from "@/components/routine-page/RoutineWebhookDialog";
import {
  PartialRoutineSaveError,
  primarySchedule,
  type RoutineSavePart,
  buildRoutineResponsibilityChoices,
  routineFieldsChanged,
  routineFieldsPayload,
  routineToDraft,
  syncRoutineResponsibility,
  syncRoutineSchedule,
} from "@/components/routine-page/routine-form";
import { resolveRoutineAddress, routinePath, type RoutineView } from "@/components/routine-page/routine-routes";
import { routineAutomationState } from "@/components/routine-page/routine-summary";
import { useRoutineFormOptions } from "@/components/routine-page/useRoutineFormOptions";
import { useRoutineWebhookDialog } from "@/components/routine-page/useRoutineWebhookDialog";
import { RoutineAuditActivity } from "@/pages/audit/RoutineAuditActivity";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToastActions } from "@/context/ToastContext";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { configurationWarningMessages } from "@/lib/configuration-warnings";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";

/** Tasks shown per History page; "Load more" fetches the next page. */
export const ROUTINE_HISTORY_PAGE_SIZE = 20;

export function routineHistoryQueryKey(companyId: string, routineId: string) {
  return [...queryKeys.issues.list(companyId), "routine", routineId, "history"] as const;
}

/** `/routines/:routineId` and its two sub-views; every older section address redirects here. */
export function RoutineDetail() {
  const { routineId, section } = useParams<{ routineId: string; section?: string }>();
  const [searchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  if (!selectedCompanyId) return <EmptyState icon={Repeat} message="Select an organization to view routines." />;
  if (!routineId) return <Navigate to="/routines" replace />;
  const address = resolveRoutineAddress({ routineId, section, legacyTab: searchParams.get("tab") });
  if (address.redirectTo) return <Navigate to={address.redirectTo} replace />;
  return <RoutineDetailPage key={routineId} companyId={selectedCompanyId} routineId={routineId} view={address.view} />;
}

function withCurrent<T extends { id: string }>(options: readonly T[], all: readonly T[], currentId: string | null | undefined): T[] {
  if (!currentId || options.some((option) => option.id === currentId)) return [...options];
  const current = all.find((option) => option.id === currentId);
  return current ? [...options, current] : [...options];
}

function RoutineDetailPage({ companyId, routineId, view }: { companyId: string; routineId: string; view: RoutineView }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs, setBreadcrumbToolbar } = useBreadcrumbs();
  const { isMobile } = useSidebar();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const options = useRoutineFormOptions(companyId);

  const [editOpen, setEditOpen] = useState(false);
  const [editInitial, setEditInitial] = useState<RoutineFormDraft | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removedWebhooks, setRemovedWebhooks] = useState<RoutineTrigger[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  // A link to one instruction comment opens the whole text with its comments,
  // also when only the fragment changes on a routine already on screen.
  const { hash: locationHash } = useLocation();
  const [commentsOpen, setCommentsOpen] = useState(() => locationHash.startsWith("#document-description"));
  useEffect(() => {
    if (locationHash.startsWith("#document-description")) setCommentsOpen(true);
  }, [locationHash]);
  /** The revision the open form started from; refreshed after this person's own changes. */
  const baseRevisionRef = useRef<{ id: string | null; number: number } | null>(null);
  /** The direct responsibility when the form opened; Save only moves the link when the person changed it. */
  const editResponsibilityRef = useRef("");
  /** The schedule the form opened with, by id; Save changes only this one. */
  const editScheduleIdRef = useRef<string | null>(null);
  const [pageRemoved, setPageRemoved] = useState<RoutineTrigger[]>([]);
  const editOpenRef = useRef(false);
  editOpenRef.current = editOpen;
  const [webhookDialogOpen, setWebhookDialogOpen] = useState(false);

  const detailKey = queryKeys.routines.detail(routineId);
  const routineQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => routinesApi.get(routineId),
    // Live webhook status while its dialog is open (test events, first delivery).
    refetchInterval: webhookDialogOpen ? 2000 : false,
  });
  const routineView = useQueryView(routineQuery);
  const routine = routineView.data;
  const routineRef = useRef(routine);
  routineRef.current = routine;

  const historyQuery = useInfiniteQuery({
    queryKey: routineHistoryQueryKey(companyId, routineId),
    queryFn: ({ pageParam }) =>
      issuesApi.list(companyId, {
        originKind: "routine_execution",
        originId: routineId,
        limit: ROUTINE_HISTORY_PAGE_SIZE + 1,
        offset: pageParam,
        sortField: "created",
        sortDir: "desc",
      }),
    initialPageParam: 0,
    getNextPageParam: (last: Issue[], pages: Issue[][]) =>
      last.length > ROUTINE_HISTORY_PAGE_SIZE ? pages.length * ROUTINE_HISTORY_PAGE_SIZE : undefined,
    enabled: view === "routine",
  });
  const historyView = useQueryView(historyQuery);
  const history = useMemo(
    () => (historyQuery.data?.pages ?? []).flatMap((page) => page.slice(0, ROUTINE_HISTORY_PAGE_SIZE)),
    [historyQuery.data],
  );

  const linksQuery = useQuery({
    queryKey: queryKeys.responsibilities.routineLinks(companyId, routineId),
    queryFn: () => responsibilitiesApi.lookupRoutineLinks(companyId, routineId),
    enabled: options.responsibilitiesOn,
  });
  const linkEntries = linksQuery.data?.responsibilities;
  const linksView = useQueryView(linksQuery);

  const annotationTarget = { kind: "routine" as const, routineId, documentKey: "description" as const };
  const annotationsQuery = useQuery({
    queryKey: queryKeys.routines.documentAnnotations(routineId, "description", "all"),
    queryFn: () => documentAnnotationsApi.listForTarget(annotationTarget, { status: "all", includeComments: true }),
    enabled: Boolean(routine?.descriptionDocument),
    staleTime: 30_000,
  });
  const openCommentCount = (annotationsQuery.data ?? []).filter(
    (thread) => thread.status === "open" && thread.anchorState !== "orphaned",
  ).length;

  /** Refetches the routine after a change; an open form adopts the new revision as its own. */
  const refreshRoutine = useCallback(async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: detailKey, queryFn: () => routinesApi.get(routineId), staleTime: 0 });
    // Each change made from the open form adds one revision. Adopt it only when
    // nothing else changed the routine, so a save still reports someone else's edit.
    const base = baseRevisionRef.current;
    if (editOpenRef.current && base && fresh.latestRevisionNumber - base.number <= 1) {
      baseRevisionRef.current = { id: fresh.latestRevisionId, number: fresh.latestRevisionNumber };
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.routines.revisions(routineId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.routines.activity(companyId, routineId) });
    return fresh;
  }, [companyId, detailKey, queryClient, routineId]);

  const webhook = useRoutineWebhookDialog({
    routineId,
    triggers: routine?.triggers ?? [],
    onChanged: refreshRoutine,
    onRemoved: (trigger) => {
      if (editOpenRef.current) setRemovedWebhooks((current) => [...current, trigger]);
      else setPageRemoved((current) => [...current, trigger]);
    },
  });
  useEffect(() => setWebhookDialogOpen(webhook.open), [webhook.open]);

  const toastError = useCallback(
    (title: string, error: unknown, action: string) => pushToast({ title, body: describeError(error, { action }).body, tone: "error" }),
    [pushToast],
  );

  const setStatus = useMutation({
    mutationFn: (status: "active" | "paused" | "archived") => routinesApi.update(routineId, { status }),
    onSuccess: async (_saved, status) => {
      pushToast({
        title: status === "active" ? "Routine is on" : status === "paused" ? "Routine paused" : "Routine archived",
        tone: "success",
      });
      await refreshRoutine();
    },
    onError: (error) => toastError("Couldn’t change the routine", error, "change the routine"),
  });

  const runRoutine = useMutation({
    mutationFn: (data?: RoutineRunDialogSubmitData) =>
      routinesApi.run(routineId, {
        ...(data?.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
        ...(data?.assigneeAgentId !== undefined ? { assigneeAgentId: data.assigneeAgentId } : {}),
        ...(data?.projectId !== undefined ? { projectId: data.projectId } : {}),
        ...(data?.executionWorkspaceId !== undefined ? { executionWorkspaceId: data.executionWorkspaceId } : {}),
        ...(data?.executionWorkspacePreference !== undefined ? { executionWorkspacePreference: data.executionWorkspacePreference } : {}),
        ...(data?.executionWorkspaceSettings !== undefined ? { executionWorkspaceSettings: data.executionWorkspaceSettings } : {}),
      }),
    onSuccess: async () => {
      pushToast({ title: "Routine run started", tone: "success" });
      setRunOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: routineHistoryQueryKey(companyId, routineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.runs(routineId) }),
        refreshRoutine(),
      ]);
    },
    onError: (error) => toastError("Routine run failed", error, "start the routine run"),
  });

  /** Saves, pauses, resumes, removes (with Undo on the page) or restores one trigger from the page. */
  const changeTrigger = useMutation({
    mutationFn: ({ trigger, patch }: { trigger: RoutineTrigger; patch: Record<string, unknown>; success: string }) =>
      routinesApi.updateTrigger(trigger.id, patch),
    onSuccess: async (_saved, { trigger, patch, success }) => {
      if (patch.archived === true) setPageRemoved((current) => [...current, trigger]);
      else if (patch.archived === false) setPageRemoved((current) => current.filter((item) => item.id !== trigger.id));
      else pushToast({ title: success, tone: "success" });
      await refreshRoutine();
    },
    onError: (error) => toastError("Couldn’t change this trigger", error, "change this trigger"),
  });
  const triggerById = (id: string) => routineRef.current?.triggers.find((trigger) => trigger.id === id);

  const saveEdits = useMutation({
    mutationFn: async (draft: RoutineFormDraft) => {
      const latest = routineRef.current;
      if (!latest) throw new Error("This routine is still loading. Try again in a moment.");
      const saved = routineToDraft(latest, editResponsibilityRef.current);
      const responsibleUserChanged = Boolean(draft.responsibleUserId)
        && draft.responsibleUserId !== saved.responsibleUserId
        && latest.canChangeResponsibleUser !== false;
      let warnings: string | null = null;
      // Each step records what it saved, so a retry after a partial failure only does what is left.
      const savedParts: RoutineSavePart[] = [];
      if (routineFieldsChanged(draft, saved) || responsibleUserChanged) {
        const updated = await routinesApi.update(routineId, {
          ...routineFieldsPayload(draft),
          ...(responsibleUserChanged ? { responsibleUserId: draft.responsibleUserId } : {}),
          ...(baseRevisionRef.current?.id ? { baseRevisionId: baseRevisionRef.current.id } : {}),
        });
        baseRevisionRef.current = { id: updated.latestRevisionId, number: updated.latestRevisionNumber };
        warnings = configurationWarningMessages(updated);
        savedParts.push("details");
      }
      try {
        const schedule = await syncRoutineSchedule(routineId, latest.triggers, editScheduleIdRef.current, draft.schedule);
        editScheduleIdRef.current = schedule.scheduleId;
        if (schedule.changed) {
          savedParts.push("schedule");
          await refreshRoutine();
        }
      } catch (error) {
        if (savedParts.length > 0) throw new PartialRoutineSaveError(savedParts, "schedule", error);
        throw error;
      }
      if (options.responsibilitiesOn) {
        try {
          if (await syncRoutineResponsibility(routineId, editResponsibilityRef.current, draft.responsibilityId)) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });
          }
          editResponsibilityRef.current = draft.responsibilityId;
        } catch (error) {
          if (savedParts.length > 0) throw new PartialRoutineSaveError(savedParts, "responsibility", error);
          throw error;
        }
      }
      return warnings;
    },
    onMutate: () => {
      setSaveError(null);
      setSaveConflict(false);
    },
    onSuccess: async (warnings) => {
      setEditOpen(false);
      setRemovedWebhooks([]);
      pushToast(warnings ? { title: "Routine saved", body: warnings, tone: "warn" } : { title: "Routine saved", tone: "success" });
      await refreshRoutine();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setSaveConflict(true);
        return;
      }
      setSaveError(error instanceof PartialRoutineSaveError ? error.message : describeError(error, { action: "save the routine" }).body);
      void refreshRoutine().catch(() => undefined);
    },
  });

  /** The routine's direct responsibility, read before the form opens so Save never unlinks one it had not loaded. */
  const loadDirectResponsibility = useCallback(async () => {
    if (!options.responsibilitiesOn) return "";
    const links = await queryClient.fetchQuery({
      queryKey: queryKeys.responsibilities.routineLinks(companyId, routineId),
      queryFn: () => responsibilitiesApi.lookupRoutineLinks(companyId, routineId),
    });
    return links.responsibilities.find((entry) => entry.via === "direct")?.id ?? "";
  }, [companyId, options.responsibilitiesOn, queryClient, routineId]);

  const openEdit = useCallback(async () => {
    const current = routineRef.current;
    if (!current) return;
    let responsibilityId = "";
    try {
      responsibilityId = await loadDirectResponsibility();
    } catch (error) {
      toastError("Couldn’t open the editor", error, "load this routine’s responsibility");
      return;
    }
    editResponsibilityRef.current = responsibilityId;
    editScheduleIdRef.current = primarySchedule(current.triggers)?.id ?? null;
    setEditInitial(routineToDraft(current, responsibilityId));
    baseRevisionRef.current = { id: current.latestRevisionId, number: current.latestRevisionNumber };
    setSaveConflict(false);
    setSaveError(null);
    setRemovedWebhooks([]);
    setEditOpen(true);
  }, [loadDirectResponsibility, toastError]);

  const reloadLatest = useCallback(async () => {
    try {
      const fresh = await refreshRoutine();
      const responsibilityId = await loadDirectResponsibility();
      editResponsibilityRef.current = responsibilityId;
      editScheduleIdRef.current = primarySchedule(fresh.triggers)?.id ?? null;
      baseRevisionRef.current = { id: fresh.latestRevisionId, number: fresh.latestRevisionNumber };
      setEditInitial(routineToDraft(fresh, responsibilityId));
      setSaveConflict(false);
      setSaveError(null);
    } catch (error) {
      setSaveError(describeError(error, { action: "reload the routine" }).body);
    }
  }, [loadDirectResponsibility, refreshRoutine]);

  const restoreWebhook = useMutation({
    mutationFn: (trigger: RoutineTrigger) => routinesApi.updateTrigger(trigger.id, { archived: false }),
    onSuccess: async (_saved, trigger) => {
      setRemovedWebhooks((current) => current.filter((item) => item.id !== trigger.id));
      await refreshRoutine();
    },
    onError: (error) => setSaveError(describeError(error, { action: "restore the webhook" }).body),
  });
  const removeWebhook = useMutation({
    mutationFn: (trigger: RoutineTrigger) => routinesApi.updateTrigger(trigger.id, { archived: true }),
    onSuccess: async (_saved, trigger) => {
      setRemovedWebhooks((current) => [...current, trigger]);
      await refreshRoutine();
    },
    onError: (error) => setSaveError(describeError(error, { action: "remove the webhook" }).body),
  });

  const onRestoreSecretMaterials = useCallback(
    (response: RestoreRoutineRevisionResponse) => {
      if (response.secretMaterials.length === 0) return;
      navigate(routinePath(routineId));
      const restoredTriggers = new Map(response.revision.snapshot.triggers.map((trigger) => [trigger.id, trigger]));
      webhook.showKeys(response.secretMaterials.map((material) => ({
        triggerId: material.triggerId,
        webhookUrl: material.webhookUrl,
        webhookSecret: material.webhookSecret,
        signingMode: restoredTriggers.get(material.triggerId)?.signingMode ?? null,
      })));
    },
    [navigate, routineId, webhook],
  );
  const onRestored = useCallback(
    (response: RestoreRoutineRevisionResponse) => {
      queryClient.setQueryData<RoutineDetailType | undefined>(detailKey, (previous) =>
        previous
          ? { ...previous, ...response.routine, latestRevisionId: response.revision.id, latestRevisionNumber: response.revision.revisionNumber }
          : previous,
      );
      void refreshRoutine().catch(() => undefined);
    },
    [detailKey, queryClient, refreshRoutine],
  );

  const routineTitle = routine?.title;
  useEffect(() => {
    if (!routineTitle) return;
    setBreadcrumbs(
      view === "routine"
        ? [{ label: "Routines", href: "/routines" }, { label: routineTitle }]
        : [
            { label: "Routines", href: "/routines" },
            { label: routineTitle, href: routinePath(routineId) },
            { label: view === "history" ? "Version history" : "Audit log" },
          ],
    );
  }, [routineId, routineTitle, setBreadcrumbs, view]);

  // Header actions sit in the shell header where it has a page toolbar; elsewhere above the page.
  const archived = routine ? routineAutomationState(routine) === "archived" : false;
  const actionsInToolbar = streamlinedUiEnabled && !isMobile;
  const handlers = useRef({
    edit: openEdit,
    run: () => setRunOpen(true),
    versions: () => navigate(routinePath(routineId, "history")),
    audit: () => navigate(routinePath(routineId, "activity")),
    archive: () => setStatus.mutate("archived"),
    restore: () => setStatus.mutate("paused"),
  });
  handlers.current = {
    edit: openEdit,
    run: () => setRunOpen(true),
    versions: () => navigate(routinePath(routineId, "history")),
    audit: () => navigate(routinePath(routineId, "activity")),
    archive: () => setStatus.mutate("archived"),
    restore: () => setStatus.mutate("paused"),
  };
  const hasRoutine = Boolean(routine);
  const runPending = runRoutine.isPending;
  const actions = useMemo(
    () =>
      hasRoutine && view === "routine" ? (
        <RoutinePageActions
          archived={archived}
          runPending={runPending}
          onEdit={() => handlers.current.edit()}
          onRunNow={() => handlers.current.run()}
          onOpenVersionHistory={() => handlers.current.versions()}
          onOpenAuditLog={() => handlers.current.audit()}
          onArchive={() => handlers.current.archive()}
          onRestore={() => handlers.current.restore()}
        />
      ) : null,
    [archived, hasRoutine, runPending, view],
  );
  useEffect(() => {
    if (!actionsInToolbar) return;
    setBreadcrumbToolbar(actions);
    return () => setBreadcrumbToolbar(null);
  }, [actions, actionsInToolbar, setBreadcrumbToolbar]);

  const routineProjectId = routine?.projectId ?? null;
  const routineAgentId = routine?.assigneeAgentId ?? null;
  // Stable between refreshes, so the form's pickers do not rebuild their indexes on every poll.
  const agents = useMemo(
    () => withCurrent<RoutinePageAgent>(options.agents, options.allAgents, routineAgentId),
    [options.agents, options.allAgents, routineAgentId],
  );
  const projects = useMemo(
    () => withCurrent<RoutinePageProject>(options.projects, options.allProjects, routineProjectId),
    [options.projects, options.allProjects, routineProjectId],
  );
  const responsibilityChoices = useMemo(
    () => buildRoutineResponsibilityChoices({
      links: linkEntries ?? [],
      options: options.responsibilities ?? [],
      areaTitles: options.areaTitles,
      projectId: routineProjectId,
    }),
    [linkEntries, options.areaTitles, options.responsibilities, routineProjectId],
  );

  // Keep a loaded routine on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (routineView.kind === "loading" || routineView.kind === "reconnecting") {
    return <PageSkeleton variant="issues-list" />;
  }
  if (routineView.kind === "error" && !routine) {
    return (
      <QueryErrorState
        size="page"
        error={routineView.error}
        action="load this routine"
        onRetry={routineView.retry}
        retrying={routineView.isFetching}
      />
    );
  }
  if (!routine) return <EmptyState icon={AlertCircle} message="We couldn't load this routine." />;

  const agent = options.allAgents.find((candidate) => candidate.id === routine.assigneeAgentId)
    ?? (routine.assignee ? { id: routine.assignee.id, name: routine.assignee.name, urlKey: routine.assignee.urlKey } : null);
  const project = options.allProjects.find((candidate) => candidate.id === routine.projectId)
    ?? (routine.project ? { id: routine.project.id, name: routine.project.name } : null);
  const responsibleUser = routine.responsibleUserId
    ? options.people.find((person) => person.id === routine.responsibleUserId)
      ?? (options.peopleFailed || options.people.length === 0 ? { id: routine.responsibleUserId, name: options.peopleFailed ? "Couldn’t load this person" : "Loading…" } : { id: routine.responsibleUserId, name: "Former member" })
    : null;
  const pageResponsibilities = options.responsibilitiesOn ? responsibilityChoices.onPage : undefined;
  const responsibilityOptions = options.responsibilities ? responsibilityChoices.choices : undefined;
  const loadErrors = [
    // The routine stays on screen through a failed refresh; say so instead of showing stale data silently.
    ...(routineView.kind === "error"
      ? [{ action: "refresh this routine", error: routineView.error, retry: routineView.retry, retrying: routineView.isFetching }]
      : []),
    ...options.loadErrors,
    ...(linksView.kind === "error"
      ? [{ action: "load this routine’s responsibilities", error: linksView.error, retry: linksView.retry, retrying: linksView.isFetching }]
      : []),
  ];
  const webhooks = routine.triggers.filter((trigger) => trigger.kind === "webhook");
  const routineActive = routineAutomationState(routine) === "active";
  const webhookDialog = (
    <RoutineWebhookDialog {...webhook.dialogProps} routineTitle={routine.title} routineActive={routineActive} />
  );
  const descriptionDocument = routine.descriptionDocument;

  const page =
    view === "routine" ? (
      <RoutinePage
        routine={routine}
        agent={agent}
        project={project}
        responsibleUser={responsibleUser}
        responsibilities={pageResponsibilities}
        history={history}
        historyLoading={historyView.kind === "loading" || historyView.kind === "reconnecting"}
        historyError={
          historyView.kind === "error" ? (
            <QueryErrorState
              size="inline"
              error={historyView.error}
              action="load this routine’s tasks"
              onRetry={historyView.retry}
              retrying={historyView.isFetching}
            />
          ) : null
        }
        hasMoreHistory={Boolean(historyQuery.hasNextPage)}
        loadingMoreHistory={historyQuery.isFetchingNextPage}
        onLoadMoreHistory={() => void historyQuery.fetchNextPage()}
        historyLinkState={createIssueDetailLocationState(routine.title, routinePath(routine.id), "issues")}
        skippedRunCount={routine.recentRuns.filter((run) => run.status === "coalesced").length}
        instructionCommentCount={openCommentCount}
        onOpenInstructionComments={() => setCommentsOpen(true)}
        instructionsExpanded={commentsOpen}
        renderInstructionsBody={
          descriptionDocument
            ? (body) => (
                <IssueDocumentAnnotations
                  issueId={routine.id}
                  doc={descriptionDocument}
                  target={annotationTarget}
                  bodyMarkdown={routine.description ?? ""}
                  draftDirty={false}
                  draftConflicted={false}
                  historicalPreview={false}
                  locationHash={locationHash}
                  panelOpen={commentsOpen}
                  onPanelOpenChange={setCommentsOpen}
                >
                  {body}
                </IssueDocumentAnnotations>
              )
            : undefined
        }
        statusPending={setStatus.isPending}
        onToggleActive={(active) => setStatus.mutate(active ? "active" : "paused")}
        onEdit={openEdit}
        onSaveSchedule={(id, change) => {
          const trigger = triggerById(id);
          if (trigger) changeTrigger.mutate({ trigger, patch: change, success: "Schedule saved" });
        }}
        onRemoveSchedule={(id) => {
          const trigger = triggerById(id);
          if (trigger) changeTrigger.mutate({ trigger, patch: { archived: true }, success: "Schedule removed" });
        }}
        onSetTriggerPaused={(id, paused) => {
          const trigger = triggerById(id);
          if (trigger) changeTrigger.mutate({ trigger, patch: { enabled: !paused }, success: paused ? "Paused" : "Resumed" });
        }}
        onRemoveTrigger={(trigger) => changeTrigger.mutate({ trigger, patch: { archived: true }, success: "Removed" })}
        removedTriggers={pageRemoved}
        onRestoreTrigger={(trigger) => changeTrigger.mutate({ trigger, patch: { archived: false }, success: "Restored" })}
        onOpenWebhook={(trigger) => webhook.show(trigger)}
      />
    ) : (
      <RoutineSubpage
        routineTitle={routine.title}
        title={view === "history" ? "Version history" : "Audit log"}
        onBack={() => navigate(routinePath(routine.id))}
      >
        {view === "history" ? (
          <RoutineHistoryTab
            routine={routine}
            isEditDirty={false}
            dirtyFields={[]}
            onDiscardEdits={() => {}}
            onSaveEdits={() => {}}
            agents={new Map(options.allAgents.map((candidate) => [candidate.id, candidate]))}
            projects={new Map(options.allProjects.map((candidate) => [candidate.id, candidate]))}
            secrets={options.secrets}
            onRestoreSecretMaterials={onRestoreSecretMaterials}
            onRestored={onRestored}
          />
        ) : (
          <RoutineAuditActivity companyId={companyId} routineId={routine.id} />
        )}
      </RoutineSubpage>
    );

  return (
    <div className="-m-4 md:-m-6">
      {!actionsInToolbar && actions ? <div className="flex justify-end px-4 pt-3 md:px-8">{actions}</div> : null}
      {loadErrors.length > 0 ? (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 pt-4 md:px-8">
          {loadErrors.map((failure) => (
            <QueryErrorState
              key={failure.action}
              size="inline"
              error={failure.error}
              action={failure.action}
              onRetry={failure.retry}
              retrying={failure.retrying}
            />
          ))}
        </div>
      ) : null}
      {page}

      {editInitial ? (
        <RoutineEditDialog
          open={editOpen}
          onOpenChange={(open) => {
            if (open) return;
            if (webhook.open) void webhook.close();
            setEditOpen(false);
            setRemovedWebhooks([]);
          }}
          initial={editInitial}
          agents={agents}
          projects={projects}
          people={options.people}
          secrets={options.secrets}
          responsibilities={responsibilityOptions}
          mentions={options.mentions}
          canChangeResponsibleUser={routine.canChangeResponsibleUser !== false}
          saving={saveEdits.isPending}
          saveConflict={saveConflict}
          error={saveError ?? (loadErrors.length > 0 ? "Some choices couldn’t be loaded. Close this and use Retry on the page." : null)}
          onSave={(draft) => saveEdits.mutate(draft)}
          onReloadLatest={() => void reloadLatest()}
          onCreateSecret={options.createSecret}
          webhooks={webhooks}
          onOpenWebhook={(trigger) => webhook.show(trigger)}
          onRemoveWebhook={(trigger) => removeWebhook.mutate(trigger)}
          removedWebhooks={removedWebhooks}
          onRestoreWebhook={(trigger) => restoreWebhook.mutate(trigger)}
        >
          {editOpen ? webhookDialog : null}
        </RoutineEditDialog>
      ) : null}

      {editOpen ? null : webhookDialog}

      <RoutineRunVariablesDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        companyId={routine.companyId}
        routineName={routine.title}
        agents={options.allAgents}
        projects={options.allProjects}
        defaultProjectId={routine.projectId}
        defaultAssigneeAgentId={routine.assigneeAgentId}
        variables={routine.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => runRoutine.mutate(data)}
      />
    </div>
  );
}
