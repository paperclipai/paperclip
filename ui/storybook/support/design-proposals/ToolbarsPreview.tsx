import { SkillsNavigationTabs } from "@/components/skill-studio/SkillsNavigationTabs";
import { RoutinesToolbar, type RoutineSortField, type RoutineSortDir, type RoutineGroupBy } from "@/components/RoutinesToolbar";
import type { AttentionItem } from "@paperclipai/shared";
import { useState, type ReactNode } from "react";
import { DecisionsToolbar } from "@/components/DecisionsToolbar";
import { ProjectsToolbar, type ProjectSortField, type ProjectSortDir } from "@/components/ProjectsToolbar";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { SkillsToolbar, type DiscoverySort } from "@/components/skill-studio/SkillsToolbar";
import { ArtifactsToolbar } from "@/components/artifacts/ArtifactsToolbar";
import type { ArtifactGroupBy, ArtifactKindFilter } from "@/api/artifacts";
import { Button } from "@/components/ui/button";
import { FlyoutAppearanceProvider } from "@/components/ui/flyout";
import { useCompany } from "@/context/CompanyContext";
import { useTaskListCollection } from "@/hooks/useTaskListCollection";
import { defaultAttentionFilterState, countActiveAttentionFilters, filterAttentionItems, type AttentionFilterOptions, type AttentionGroupBy, type AttentionSortOrder } from "@/lib/attention";
import { storybookAgents, storybookAuthSession, storybookIssueLabels, storybookProjects } from "../../fixtures/paperclipData";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { initialItems } from "./task-page-data";

export type ToolbarsPreviewProps = {
  family: "all" | "tasks" | "decisions" | "skills" | "artifacts" | "projects" | "routines";
  width: "full" | "medium" | "narrow";
  onWidthChange?: (width: ToolbarsPreviewProps["width"]) => void;
};
const widths = { full: "max-w-none", medium: "max-w-3xl", narrow: "max-w-sm" };
const attentionOptions: AttentionFilterOptions = {
  sourceKinds: ["approval", "review", "failed_run"], severities: ["critical", "high", "low"],
  projects: [], workspaces: [], hasNoProject: true, hasNoWorkspace: true,
};

const decisionItems = [
  { id: "review", sourceKind: "review" as const, severity: "high" as const, subject: { title: "Review connector recovery", identifier: "DES-3" }, whyNow: "Verification complete", originAgentName: "Connector engineer" },
  { id: "approval", sourceKind: "approval" as const, severity: "critical" as const, subject: { title: "Approve workspace access", identifier: "DES-8" }, whyNow: "Agent needs approval", originAgentName: "Design reviewer" },
].map((item): AttentionItem => ({
  ...item,
  companyId: "storybook-company", subject: { ...item.subject, kind: "issue", id: item.id, companyId: "storybook-company", status: "in_review", href: null },
  decisionVerbs: [], inlineResolvable: false, entryRule: "", exitRule: "", dedupKey: item.id, dismissalKey: item.id,
  dismissal: null, rank: 0, activityAt: "2026-10-16T12:00:00Z", createdAt: "2026-10-16T12:00:00Z", updatedAt: "2026-10-16T12:00:00Z",
  project: null, workspace: null, relatedIssue: null, detail: null, expiresAt: null, ruleKey: null, queues: [], shelf: false,
  retentionDays: 30, keep: false, archivedAt: null, retentionVersion: 1, decideBy: null, decideByAttribution: null, snoozedUntil: null, trainingExampleId: null,
}));

function Specimen({ title, source, children }: { title: string; source: string; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 space-y-4 border-t border-border pt-6">
    <div className="space-y-1"><h2 className="text-lg font-normal text-foreground">{title}</h2><p className="text-xs text-muted-foreground">{source}</p></div>
    {children}
  </section>;
}

function TaskToolbarSpecimen() {
  const { selectedCompanyId } = useCompany();
  const collection = useTaskListCollection({ items: initialItems, companyId: selectedCompanyId, userId: storybookAuthSession.user.id, viewStorageKey: "paperclip:design-proposals:toolbars:task-view" });
  const [action, setAction] = useState("");
  return <Specimen title="Task toolbar" source="TaskListToolbar · canonical task controls used by Pages / Tasks and the sandbox Tasks page">
    <TaskListToolbar view={collection.view} onViewChange={collection.setView} query={collection.query} onQueryChange={collection.setQuery}
      layout={collection.layout} onLayoutChange={collection.setLayout} allExpanded={collection.allExpanded} onToggleExpanded={collection.toggleExpanded}
      onNewTask={() => setAction("New Task requested · local preview only")}
      filters={{ state: collection.filters, onChange: collection.updateFilters, activeFilterCount: collection.activeFilterCount, agents: storybookAgents, projects: storybookProjects, labels: storybookIssueLabels, currentUserId: storybookAuthSession.user.id, creators: collection.creators }} />
    <output aria-live="polite" className="block text-xs text-muted-foreground">{collection.matchingItems.length} matching tasks · {collection.layout === "list" ? "List" : "Board"} · {collection.allExpanded ? "Expanded" : "Collapsed"}{action ? ` · ${action}` : ""}</output>
  </Specimen>;
}

function DecisionsToolbarSpecimen() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(defaultAttentionFilterState);
  const [groupBy, setGroupBy] = useState<AttentionGroupBy>("none");
  const [sortOrder, setSortOrder] = useState<AttentionSortOrder>("newest");
  return <Specimen title="Decisions toolbar" source="DecisionsToolbar · shipped filter, group and sort controls shared by WhatNeedsMe and DecisionQueuePage">
    <DecisionsToolbar query={query} onQueryChange={setQuery} visibleCount={filterAttentionItems(decisionItems, filters, query).length} filterOptions={attentionOptions} filters={filters} onFiltersChange={setFilters} groupBy={groupBy} onGroupByChange={setGroupBy} sortOrder={sortOrder} onSortOrderChange={setSortOrder} />
    <output aria-live="polite" className="block text-xs text-muted-foreground">{countActiveAttentionFilters(filters)} active filters · Group: {groupBy} · Sort: {sortOrder} · Search: {query || "All decisions"}</output>
  </Specimen>;
}

function SkillsToolbarSpecimen() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DiscoverySort>("agents");
  const [source, setSource] = useState("all");
  const [scanPending, setScanPending] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [action, setAction] = useState("");
  const report = (label: string) => () => setAction(`${label} requested · local preview only`);
  return <Specimen title="Skills toolbar" source="SkillsToolbar · extracted from CompanySkills and reused by the sandbox. Original search, sort, source, scan and creation controls.">
    <SkillsToolbar navigation={<SkillsNavigationTabs activeView="installed" />} viewTitle="Installed skills" viewDescription="Skills available to this organization." searchLabel="Search installed skills"
      search={search} onSearchChange={setSearch} sort={sort} onSortChange={setSort}
      availableSources={[{ value: "github", label: "GitHub" }, { value: "local", label: "Local" }]} sourceBadgeFilter={source} setSourceBadgeFilter={setSource}
      onScan={() => { setScanPending(true); setAction("Scanning project workspaces · local preview only"); }} scanPending={scanPending}
      onCreate={report("Create skill")} onBrowseDiscover={report("Discover skills")} onImport={report("Import skill")} onImportFromProject={report("Import from project")}
      onCreateFolder={report("New folder")} selectMode={selectMode} onToggleSelectMode={() => setSelectMode(value => !value)} />
    {scanPending && <Button variant="outline" size="sm" onClick={() => { setScanPending(false); setAction("Scan completed · local preview only"); }}>Complete simulated scan</Button>}
    <output aria-live="polite" className="block text-xs text-muted-foreground">Search: {search || "All skills"} · Sort: {sort} · Source: {source} · {selectMode ? "Selecting" : "Browsing"}{action ? ` · ${action}` : ""}</output>
  </Specimen>;
}

function ArtifactsToolbarSpecimen() {
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<ArtifactGroupBy>("task");
  const [kind, setKind] = useState<ArtifactKindFilter>("all");
  return <Specimen title="Artifacts toolbar" source="ArtifactsToolbar · extracted from Artifacts and reused by the sandbox. Search, grouping and type filters use the shared toolbar control geometry. Type-filter styling outside toolbars is reviewed separately in Tabs.">
    <ArtifactsToolbar query={query} onQueryChange={setQuery} groupBy={groupBy} onGroupByChange={setGroupBy} kind={kind} onKindChange={setKind} />
    <output aria-live="polite" className="block text-xs text-muted-foreground">Search: {query || "All artifacts"} · Group: {groupBy} · Type: {kind}</output>
  </Specimen>;
}

function ProjectsToolbarSpecimen() {
  const [query, setQuery] = useState("");
  const [field, setField] = useState<ProjectSortField>("name");
  const [direction, setDirection] = useState<ProjectSortDir>("asc");
  const [action, setAction] = useState("");
  return <Specimen title="Projects toolbar" source="ProjectsToolbar · shared project search, sort direction and Add Project action used by the Projects page.">
    <ProjectsToolbar query={query} onQueryChange={setQuery} sortField={field} sortDir={direction} onSortChange={(nextField, nextDirection) => { setField(nextField); setDirection(nextDirection); }} onNewProject={() => setAction("Add Project requested · local preview only")} />
    <output className="block text-xs" aria-live="polite">Search: {query || "All projects"} · Sort: {field} · Direction: {direction}{action ? ` · ${action}` : ""}</output>
  </Specimen>;
}

function RoutinesToolbarSpecimen() {
  const [query, setQuery] = useState("");
  const [field, setField] = useState<RoutineSortField>("updated");
  const [direction, setDirection] = useState<RoutineSortDir>("desc");
  const [group, setGroup] = useState<RoutineGroupBy>("folder");
  const [action, setAction] = useState("");
  return <Specimen title="Routines toolbar" source="RoutinesToolbar · shared routine search, sorting, grouping, folder creation and run history controls used by the Routines page.">
    <RoutinesToolbar query={query} onQueryChange={setQuery} sortField={field} sortDir={direction} groupBy={group}
      onSortChange={(nextField, nextDirection) => { setField(nextField); setDirection(nextDirection); }} onGroupChange={setGroup}
      runsHref="/activity/runs" onNewFolder={group === "folder" ? () => setAction("New folder requested · local preview only") : undefined}
      onCreateRoutine={() => setAction("Create routine requested · local preview only")} />
    <output className="block text-xs" aria-live="polite">Search: {query || "All routines"} · Sort: {field} · Direction: {direction} · Group: {group}{action ? ` · ${action}` : ""}</output>
  </Specimen>;
}

export function ToolbarsPreview({ family, width, onWidthChange }: ToolbarsPreviewProps) {
  return <FlyoutAppearanceProvider><DesignProposalAccess>
    <main data-testid="toolbars-preview" className="min-h-dvh space-y-8 bg-background p-6 font-sans text-muted-foreground sm:p-10">
      <header className="space-y-3"><p className="text-xs">Design proposals · Components</p><h1 className="text-2xl font-semibold text-foreground">Toolbars</h1>
        <p className="max-w-3xl text-sm">Canonical toolbar references for Design Proposals. Reuse the component for its job; task views, decision grouping, skill discovery and artifact browsing remain distinct patterns. Shared foundations, buttons, focus states and flyouts apply to each.</p>
        <label className="flex w-fit items-center gap-3 text-xs">Container width<select className="rounded-md border border-border bg-background px-3 py-2 text-sm" aria-label="Toolbar container width" value={width} onChange={event => onWidthChange?.(event.target.value as ToolbarsPreviewProps["width"])}><option value="full">Full</option><option value="medium">Medium</option><option value="narrow">Narrow</option></select></label>
      </header>
      <div className={`w-full space-y-8 ${widths[width]}`} data-testid="toolbar-specimens" data-container-width={width}>
        {(family === "all" || family === "tasks") && <TaskToolbarSpecimen />}
        {(family === "all" || family === "decisions") && <DecisionsToolbarSpecimen />}
        {(family === "all" || family === "skills") && <SkillsToolbarSpecimen />}
        {(family === "all" || family === "artifacts") && <ArtifactsToolbarSpecimen />}
        {(family === "all" || family === "projects") && <ProjectsToolbarSpecimen />}
        {(family === "all" || family === "routines") && <RoutinesToolbarSpecimen />}
      </div>
      <p className="max-w-3xl text-xs">Local fixture state only. Search, menus, toggles and feedback can be inspected here; creation actions report an intent without changing saved data. These are canonical proposal references, with production adoption and backend verification tracked separately.</p>
    </main>
  </DesignProposalAccess></FlyoutAppearanceProvider>;
}
