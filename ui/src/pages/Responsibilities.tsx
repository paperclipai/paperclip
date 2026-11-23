import { useResolvedViewerId } from "@/hooks/useResolvedViewerId";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResponsibilityArea, ResponsibilityWithRollup } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { PageSkeleton } from "@/components/PageSkeleton";
import { QueryErrorState, QueryView, useQueryView } from "@/components/QueryView";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { AddResponsibilityDialog } from "@/components/responsibilities/AddResponsibilityDialog";
import { DashboardAgentStatus } from "@/components/responsibilities/DashboardAgentStatus";
import { DashboardAutomation } from "@/components/responsibilities/DashboardAutomation";
import { DashboardBoard } from "@/components/responsibilities/DashboardBoard";
import { DashboardChatComposer } from "@/components/responsibilities/DashboardChatComposer";
import { DashboardExceptions } from "@/components/responsibilities/DashboardExceptions";
import { DashboardOutline } from "@/components/responsibilities/DashboardOutline";
import { DashboardOutlineV2 } from "@/components/responsibilities/DashboardOutlineV2";
import { useAgentDirectory } from "@/components/responsibilities/AgentsWorking";
import { QuickAddResponsibilityDialog } from "@/components/responsibilities/QuickAddResponsibilityDialog";
import {
  AddAreaDialog,
  ArchiveAreaDialog,
  RenameAreaDialog,
  useRestoreArea,
} from "@/components/responsibilities/AreaDialogs";
import type { AreaActions } from "@/components/responsibilities/HomeSections";
import {
  ResponsibilitiesHomeLayout,
  type ResponsibilitiesHomeLayoutProps,
} from "@/components/responsibilities/ResponsibilitiesHomeLayout";
import {
  ResponsibilityDelegateDialog,
  type ResponsibilityDelegateTarget,
} from "@/components/responsibilities/ResponsibilityDelegateDialog";
import { usePageView } from "@/components/responsibilities/usePageView";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useAgentlessOnboardingAutoOpen } from "@/hooks/useAgentlessOnboardingAutoOpen";
import { queryKeys } from "@/lib/queryKeys";
import {
  delegationPrefillForReason,
  onboardingProvenance,
  type AttentionItem,
} from "@/lib/responsibilities";
import { outlineV2Counts, outlineV2CountsLabel, outlineV2Groups } from "@/lib/responsibility-outline-v2";
import { DASHBOARD_DEFAULT_VIEW, DASHBOARD_VIEW_OPTIONS } from "@/lib/responsibility-views";
import { cn, formatShortDate } from "@/lib/utils";

type AreaRef = Pick<ResponsibilityArea, "id" | "title" | "status">;

interface NewTaskLaunch {
  responsibility: ResponsibilityDelegateTarget;
  defaultTitle: string;
  projectId: string | null;
}

const EMPTY_AREAS: readonly AreaRef[] = [];

function ProvenanceLine({
  responsibilities,
  agentName,
}: {
  responsibilities: readonly ResponsibilityWithRollup[];
  agentName: (id: string) => string | undefined;
}) {
  const provenance = useMemo(() => onboardingProvenance(responsibilities), [responsibilities]);
  if (!provenance) return null;
  const name = provenance.agentId ? agentName(provenance.agentId) : undefined;
  return (
    <p className="text-xs text-muted-foreground">
      {name ? `Drafted by ${name} during onboarding.` : "Drafted during onboarding."}
      {provenance.confirmedAt ? ` Confirmed by you on ${formatShortDate(provenance.confirmedAt)}.` : null}
    </p>
  );
}

/**
 * The Responsibilities home, shown as "Dashboard" while the experimental flag
 * is on. Loads the overview and agents, owns every dialog and mutation, and
 * hands the loaded data to `ResponsibilitiesHomeLayout`.
 */
export function Responsibilities() {
  const { selectedCompanyId } = useCompany();
  const viewer = useResolvedViewerId();
  if (viewer.error) return <QueryErrorState error={viewer.error} action="load your dashboard" onRetry={() => { void viewer.retry(); }} />;
  if (!selectedCompanyId || !viewer.userId) return <PageSkeleton variant="dashboard" />;
  return <OwnerDashboard key={JSON.stringify([selectedCompanyId, viewer.userId])} selectedCompanyId={selectedCompanyId} ownerUserId={viewer.userId} />;
}

function OwnerDashboard({ selectedCompanyId, ownerUserId }: { selectedCompanyId: string; ownerUserId: string }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [includeLetGo, setIncludeLetGo] = useState(false);
  const [adding, setAdding] = useState<{ areaId: string | null } | null>(null);
  const [addingArea, setAddingArea] = useState(false);
  const [keepEmptyAreas, setKeepEmptyAreas] = useState<ReadonlySet<string>>(() => new Set());
  const [newTask, setNewTask] = useState<NewTaskLaunch | null>(null);
  const [renaming, setRenaming] = useState<AreaRef | null>(null);
  const [archiving, setArchiving] = useState<AreaRef | null>(null);
  const restore = useRestoreArea();
  // One dashboard, no switch between views; reviewing proposals visits the full layout.
  const { view, visiting, visit, leave } = usePageView(DASHBOARD_VIEW_OPTIONS, DASHBOARD_DEFAULT_VIEW);
  const [search, setSearch] = useState("");
  const { agents, byId: agentsById, query: agentsQuery } = useAgentDirectory(selectedCompanyId);
  const agentsView = useQueryView(agentsQuery);
  // One clock per visit: day-level judgements, and a stable value keeps rows memoized.
  const now = useMemo(() => new Date(), []);

  // This page can be home, so it carries the same first-run offer as the classic dashboard.
  useAgentlessOnboardingAutoOpen();

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const overviewQuery = useQuery({
    queryKey: queryKeys.responsibilities.overview(selectedCompanyId ?? "__none__", { includeLetGo, ownerUserId }),
    queryFn: () => responsibilitiesApi.overview(selectedCompanyId!, { includeLetGo, ownerUserId }),
    enabled: !!selectedCompanyId,
  });
  const overview = overviewQuery.data;
  const areasForNew = useMemo(
    () => overview?.areas.filter((area) => area.status !== "archived") ?? EMPTY_AREAS,
    [overview?.areas],
  );
  const ownedPerArea = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of overview?.responsibilities ?? []) if (item.areaId) counts.set(item.areaId, (counts.get(item.areaId) ?? 0) + 1);
    return counts;
  }, [overview?.responsibilities]);

  // Outline v2's one line of numbers, beside its search. Null on an empty dashboard.
  const outlineCounts = useMemo(() => {
    if (!overview) return null;
    const counts = outlineV2Counts(outlineV2Groups(overview.areas, overview.responsibilities, keepEmptyAreas));
    // The same rule as the view's empty state, which shows only the create module.
    return counts.areas > 0 || counts.responsibilities > 0 || overview.proposed.length > 0 ? counts : null;
  }, [overview, keepEmptyAreas]);

  const openAdd = useCallback((areaId: string | null) => setAdding({ areaId }), []);
  const agentName = useCallback((id: string) => agentsById.get(id)?.name, [agentsById]);
  const openNewTask = useCallback((responsibility: ResponsibilityWithRollup, item: AttentionItem) => {
    const prefill = delegationPrefillForReason(item.text, responsibility.rollup.overdueProjects);
    setNewTask({ responsibility: { id: responsibility.id, title: responsibility.title }, defaultTitle: prefill.title, projectId: prefill.projectId });
  }, []);
  const restoreArea = restore.mutate;
  const areaActions = useMemo<AreaActions>(() => ({
    onAddHere: (areaId) => openAdd(areaId),
    onRename: setRenaming,
    onArchive: setArchiving,
    onRestore: (area) => restoreArea(area.id),
  }), [openAdd, restoreArea]);

  if (!selectedCompanyId) return null;
  const isEmpty = overview !== undefined && overview.responsibilities.length === 0 && overview.proposed.length === 0;

  return (
    // The Board's four status columns get the wider page; Automation's rows span the whole content pane.
    // At least as tall as the content pane, so the composer rests at its foot on a short page.
    <div className={cn("mx-auto flex min-h-full w-full flex-col gap-8", view === "automation" ? "max-w-none" : view === "board" ? "max-w-7xl" : "max-w-5xl")}>
      {/* An empty Outline v2 has nothing to search or count: no header, so no gap above the create module. */}
      <header
        className={cn(
          "flex flex-wrap justify-between gap-4",
          view === "outline_v2" ? "items-center" : "items-start",
          view === "outline_v2" && !outlineCounts && "hidden",
        )}
      >
        {view === "outline_v2" ? (
          // The breadcrumb bar's heading already names the page: search and the counts take the headline's place.
          outlineCounts ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              <ToolbarSearch
                query={search}
                onQueryChange={setSearch}
                label="Search your dashboard"
                placeholder="Search"
                inputType="search"
              />
              <p className="text-sm text-muted-foreground" data-dashboard-counts="">{outlineV2CountsLabel(outlineCounts)}</p>
            </div>
          ) : null
        ) : (
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
            {view === "full" ? (
              <>
                <p className="text-sm text-muted-foreground">What you own, whether each one is meeting its bar, and the work underneath.</p>
                {overview ? <ProvenanceLine responsibilities={overview.responsibilities} agentName={agentName} /> : null}
              </>
            ) : null}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {visiting ? (
            <Button variant="ghost" onClick={leave} data-dashboard-back="">
              Back
            </Button>
          ) : null}
          {view === "outline_v2" ? (
            // The page's one primary action, last in the row after search.
            <Button onClick={() => setAddingArea(true)}>
              <Plus aria-hidden="true" />
              New area
            </Button>
          ) : null}
          {view === "full" || view === "board" ? (
            <>
              <Button variant="outline" onClick={() => setAddingArea(true)}>
                <Plus aria-hidden="true" />
                Add area
              </Button>
              {isEmpty ? null : (
                <Button onClick={() => openAdd(null)}>
                  <Plus aria-hidden="true" />
                  Add responsibility
                </Button>
              )}
            </>
          ) : null}
        </div>
      </header>

      {restore.error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t restore the area. {describeError(restore.error).body}
        </p>
      ) : null}

      <QueryView
        query={overviewQuery}
        size="page"
        action="load your responsibilities"
        loading={<PageSkeleton variant="dashboard" />}
      >
        {(loaded) => {
          const layoutProps: ResponsibilitiesHomeLayoutProps = {
            companyId: selectedCompanyId,
            overview: loaded,
            agents,
            agentsById,
            now,
            includeLetGo,
            onToggleLetGo: () => setIncludeLetGo((value) => !value),
            keepEmptyAreas,
            onAddResponsibility: openAdd,
            onNewTask: openNewTask,
            areaActions,
          };
          if (view === "full") return <ResponsibilitiesHomeLayout {...layoutProps} />;
          const viewProps = { ...layoutProps, onAddArea: () => setAddingArea(true), onReviewProposals: () => visit("full") };
          if (view === "outline") return <DashboardOutline {...viewProps} />;
          if (view === "outline_v2") return <DashboardOutlineV2 {...viewProps} search={search} />;
          if (view === "board") return <DashboardBoard {...viewProps} />;
          if (view === "automation") return <DashboardAutomation {...viewProps} />;
          if (view === "agent_status") return <DashboardAgentStatus {...viewProps} />;
          return <DashboardExceptions {...viewProps} />;
        }}
      </QueryView>

      {/* Start a chat from any view: anchored to the foot of the content pane
          like the chat and task composers. On a short page `mt-auto` rests it
          there; on a long one it stays pinned while the page scrolls behind
          it. Last in the page, so it never covers the last of the content.
          The dock itself is see-through and lets clicks pass: no band fades
          or clips the content beside and above the composer card. */}
      <div
        className="pointer-events-none sticky bottom-(--tc-composer-bottom) z-20 mt-auto pt-2 md:bottom-0"
        data-dashboard-chat-dock=""
      >
        <div className="pointer-events-auto">
          {agentsView.kind === "error" ? (
            <div className="mb-2 rounded-lg border border-border bg-background px-4 py-3" data-dashboard-chat="error">
              <QueryErrorState error={agentsView.error} size="inline" action="load your agents"
                onRetry={agentsView.retry} retrying={agentsView.isFetching} />
            </div>
          ) : null}
          {/* Always mounted: it owns the draft, which a failed refresh must not discard. */}
          <DashboardChatComposer companyId={selectedCompanyId} agents={agents} loaded={agentsQuery.data !== undefined} />
        </div>
      </div>

      {/* Outline v2 adds a responsibility as one sentence; its bar is set up later on its page. */}
      {view === "outline_v2" ? (
        <QuickAddResponsibilityDialog
          open={adding !== null}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          companyId={selectedCompanyId}
          areas={areasForNew}
          defaultAreaId={adding?.areaId ?? null}
        />
      ) : (
        <AddResponsibilityDialog
          open={adding !== null}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          companyId={selectedCompanyId}
          areas={areasForNew}
          defaultAreaId={adding?.areaId ?? null}
        />
      )}
      <AddAreaDialog
        open={addingArea}
        onOpenChange={setAddingArea}
        companyId={selectedCompanyId}
        onCreated={(area) => {
          setKeepEmptyAreas((current) => new Set([...current, area.id]));
          // With nothing on the page yet, the new area would not show: go straight to filling it.
          if (isEmpty) openAdd(area.id);
        }}
      />
      {newTask ? (
        <ResponsibilityDelegateDialog
          open
          onOpenChange={(open) => {
            if (!open) setNewTask(null);
          }}
          companyId={selectedCompanyId}
          responsibility={newTask.responsibility}
          defaultTitle={newTask.defaultTitle}
          projectId={newTask.projectId}
        />
      ) : null}
      <RenameAreaDialog area={renaming} onOpenChange={(open) => { if (!open) setRenaming(null); }} />
      <ArchiveAreaDialog
        area={archiving}
        ownedHere={archiving ? ownedPerArea.get(archiving.id) ?? 0 : 0}
        onOpenChange={(open) => { if (!open) setArchiving(null); }}
      />
    </div>
  );
}
