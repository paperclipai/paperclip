import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  isArtifactReviewDocumentKey,
  type Issue,
  type IssueDocument,
} from "@paperclipai/shared";
import {
  Box,
  FileCode2,
  FileText,
  FolderOpen,
  Lightbulb,
  ListTree,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { fileResourcesApi } from "@/api/file-resources";
import { IssueProperties } from "@/components/IssueProperties";
import { PROPERTIES_PANE_HEADER_SLOT_ID } from "@/components/PropertiesPanel";
import { WorkspaceFileBrowser } from "@/components/WorkspaceFileBrowser";
import { IssuePropertiesArtifactsTab } from "@/components/issue-properties/IssuePropertiesArtifactsTab";
import { IssuePropertiesPlansTab } from "@/components/issue-properties/IssuePropertiesPlansTab";
import { TaskDetailSubtasksPanel } from "@/components/task-detail/TaskDetailRelationsPanel";
import {
  SidePanelLauncher,
  SidePanelToggleButton,
  SidePanelTabs,
  useScrollbarWhileScrolling,
  useSidePanelTabs,
  type SidePanelLauncherItem,
  type SidePanelLauncherSection,
  type SidePanelTabItem,
  type SidePanelTabRecord,
} from "@/components/side-panel";
import { Button } from "@/components/ui/button";
import {
  FILE_VIEWER_NAVIGATE_OPTIONS,
  getCurrentFileViewerSearch,
  readBrowseStateFromSearch,
  readFileViewerStateFromSearch,
  shouldNavigateFileViewerSearch,
  writeBrowseStateToSearch,
  writeFileViewerStateToSearch,
  type FileViewerBrowseState,
  type FileViewerUrlState,
} from "@/context/FileViewerContext";
import { useIssueDocuments } from "@/hooks/useIssueDocuments";
import type { IssueExternalObjectGroup } from "@/hooks/useIssueExternalObjects";
import { useIssuePlanDocument } from "@/hooks/useIssuePlanDocument";
import { documentDisplayTitle } from "@/lib/issue-artifacts";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import {
  readTaskSidePanelState,
  taskPanelArtifactsTab,
  taskPanelDocumentTab,
  taskPanelFilesTab,
  taskPanelPropertiesTab,
  taskPanelSubtasksTab,
  taskPanelWorkspaceFileTab,
  writeTaskSidePanelState,
  type TaskSidePanelTabPayload,
} from "@/lib/task-side-panel-state";
import { cn } from "@/lib/utils";
import { TaskDocumentPanel } from "./TaskDocumentPanel";
import { TaskWorkspaceFilePanel } from "./TaskWorkspaceFilePanel";

export interface TaskSidePanelProps {
  issue: Issue;
  accountScope: string;
  childIssues?: Issue[];
  issueLinkState?: unknown;
  onAddSubIssue?: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
  hasActiveRun?: boolean;
  externalObjects?: IssueExternalObjectGroup[];
  externalObjectsLoading?: boolean;
  externalObjectsError?: boolean;
  onRetryExternalObjects?: () => void;
  onCheckMonitorNow?: () => void;
  checkingMonitorNow?: boolean;
  fileTabsEnabled: boolean;
  documentDeepLink?: { requestId: number; documentKey: string } | null;
  onRequestClose?: () => void;
  streamlinedTabs?: boolean;
  showSubtasksTab?: boolean;
}

const EMPTY_ISSUE_DOCUMENTS: IssueDocument[] = [];

function tabIcon(tab: SidePanelTabRecord<TaskSidePanelTabPayload>): ReactNode {
  switch (tab.payload.kind) {
    case "properties": return <SlidersHorizontal />;
    case "subtasks": return <ListTree />;
    case "artifacts": return <Box />;
    case "files-browser": return <FolderOpen />;
    case "workspace-file": return <FileCode2 />;
    case "issue-document": return tab.payload.documentKey === "plan" ? <Lightbulb /> : <FileText />;
  }
}

function insertSubtasksAfterProperties(
  tabs: SidePanelTabRecord<TaskSidePanelTabPayload>[],
) {
  if (tabs.some((tab) => tab.id === "subtasks")) return tabs;
  const propertiesIndex = tabs.findIndex((tab) => tab.id === "properties");
  const next = [...tabs];
  next.splice(propertiesIndex < 0 ? 0 : propertiesIndex + 1, 0, taskPanelSubtasksTab());
  return next;
}

function selectorForWorkspaceKind(kind: "execution_workspace" | "project_workspace") {
  return kind === "execution_workspace" ? "execution" as const : "project" as const;
}

/**
 * The desktop panel is rendered beside the route outlet, so task file routing
 * deliberately lives in this adapter instead of depending on provider ancestry.
 */
function useTaskSidePanelFileRouting() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => readFileViewerStateFromSearch(location.search), [location.search]);
  const browseState = useMemo(() => readBrowseStateFromSearch(location.search), [location.search]);
  const navigateSearch = useCallback((nextSearch: string, replace = false) => {
    if (!shouldNavigateFileViewerSearch(nextSearch, location.search)) return;
    navigate(
      { pathname: location.pathname, hash: location.hash, search: nextSearch },
      { ...FILE_VIEWER_NAVIGATE_OPTIONS, replace, state: location.state },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  const open = useCallback((ref: FileViewerUrlState, options?: {
    fromBrowse?: boolean;
    browseState?: Partial<FileViewerBrowseState>;
  }) => {
    let nextSearch = writeFileViewerStateToSearch(location.search, ref);
    if (options?.fromBrowse) {
      const params = new URLSearchParams(nextSearch);
      const previous = new URLSearchParams(location.search);
      params.set("browse", "1");
      const query = Object.prototype.hasOwnProperty.call(options.browseState ?? {}, "q")
        ? options.browseState?.q
        : previous.get("q");
      const folder = Object.prototype.hasOwnProperty.call(options.browseState ?? {}, "folderPath")
        ? options.browseState?.folderPath
        : previous.get("folder");
      if (query) params.set("q", query);
      else params.delete("q");
      if (folder) params.set("folder", folder);
      else params.delete("folder");
      nextSearch = params.toString() ? `?${params.toString()}` : "";
    }
    navigateSearch(nextSearch);
  }, [location.search, navigateSearch]);

  const openBrowse = useCallback((options?: { q?: string }) => {
    const params = new URLSearchParams(location.search);
    params.delete("file");
    params.delete("line");
    params.delete("column");
    params.delete("folder");
    params.set("browse", "1");
    if (options?.q) params.set("q", options.q);
    else params.delete("q");
    navigateSearch(params.toString() ? `?${params.toString()}` : "");
  }, [location.search, navigateSearch]);

  const updateBrowseState = useCallback((next: Partial<FileViewerBrowseState>) => {
    navigateSearch(writeBrowseStateToSearch(location.search, next), true);
  }, [location.search, navigateSearch]);

  const close = useCallback(() => {
    const currentSearch = getCurrentFileViewerSearch(location.search);
    const params = new URLSearchParams(writeFileViewerStateToSearch(currentSearch, null).replace(/^\?/, ""));
    params.delete("browse");
    params.delete("q");
    params.delete("folder");
    navigateSearch(params.toString() ? `?${params.toString()}` : "");
  }, [location.search, navigateSearch]);

  return {
    state,
    browse: browseState !== null,
    query: browseState?.q ?? null,
    folderPath: browseState?.folderPath ?? null,
    browseProjectId: browseState?.projectId ?? null,
    browseWorkspaceId: browseState?.workspaceId ?? null,
    open,
    openBrowse,
    updateBrowseState,
    close,
  };
}

export function TaskSidePanel({
  issue,
  accountScope,
  childIssues = [],
  issueLinkState,
  onAddSubIssue,
  onUpdate,
  inline = false,
  hasActiveRun = false,
  externalObjects,
  externalObjectsLoading,
  externalObjectsError,
  onRetryExternalObjects,
  onCheckMonitorNow,
  checkingMonitorNow = false,
  fileTabsEnabled,
  documentDeepLink,
  onRequestClose,
  streamlinedTabs = false,
  showSubtasksTab = false,
}: TaskSidePanelProps) {
  const handleScroll = useScrollbarWhileScrolling();
  const viewer = useTaskSidePanelFileRouting();
  const { data: documentsData } = useIssueDocuments(issue.id);
  const documents = documentsData ?? EMPTY_ISSUE_DOCUMENTS;
  const { data: planDocument } = useIssuePlanDocument(issue.id);
  const restoredRef = useRef(
    readTaskSidePanelState(accountScope, issue.companyId, issue.id, fileTabsEnabled),
  );
  const initialSubtasksAvailableRef = useRef(showSubtasksTab && childIssues.length > 0);
  const subtasksDismissedRef = useRef(
    restoredRef.current?.userInteracted === true
      && restoredRef.current.state.tabs.length === 0,
  );
  const [launcherOpen, setLauncherOpen] = useState(restoredRef.current?.launcherOpen ?? false);
  const [paneHeaderSlot, setPaneHeaderSlot] = useState<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const userInteractedRef = useRef(restoredRef.current?.userInteracted ?? false);
  const autoPlanHandledRef = useRef(restoredRef.current?.autoPlanHandled ?? false);
  const initialState = useMemo(() => {
    const restored = restoredRef.current?.state;
    let tabs = restored?.tabs ?? [taskPanelPropertiesTab()];
    if (!initialSubtasksAvailableRef.current) {
      tabs = tabs.filter((tab) => tab.payload.kind !== "subtasks");
    } else if (!subtasksDismissedRef.current) {
      tabs = insertSubtasksAfterProperties(tabs);
    }
    const requestedActive = restored?.activeTabId ?? "properties";
    return {
      tabs,
      activeTabId: tabs.some((tab) => tab.id === requestedActive)
        ? requestedActive
        : tabs[0]?.id ?? null,
    };
  }, []);

  const persist = useCallback((state: { tabs: SidePanelTabRecord<TaskSidePanelTabPayload>[]; activeTabId: string | null }) => {
    writeTaskSidePanelState(accountScope, issue.companyId, issue.id, {
      state,
      launcherOpen,
      userInteracted: userInteractedRef.current,
      autoPlanHandled: autoPlanHandledRef.current,
      updatedAt: Date.now(),
    });
  }, [accountScope, issue.companyId, issue.id, launcherOpen]);
  const controller = useSidePanelTabs<TaskSidePanelTabPayload>({ initialState, onStateChange: persist });
  const activeTab = controller.tabs.find((tab) => tab.id === controller.activeTabId) ?? null;
  const subtasksAvailable = showSubtasksTab && childIssues.length > 0;
  const hasSubtasksTab = controller.tabs.some((tab) => tab.id === "subtasks");

  useEffect(() => {
    if (!subtasksAvailable) {
      subtasksDismissedRef.current = false;
      if (hasSubtasksTab) controller.closeTab("subtasks");
      return;
    }
    if (!hasSubtasksTab && !subtasksDismissedRef.current) {
      controller.resetTabs({
        tabs: insertSubtasksAfterProperties(controller.tabs),
        activeTabId: controller.activeTabId,
      });
    }
  }, [
    controller.activeTabId,
    controller.closeTab,
    controller.resetTabs,
    controller.tabs,
    hasSubtasksTab,
    subtasksAvailable,
  ]);

  useEffect(() => {
    if (inline) {
      setPaneHeaderSlot(null);
      return;
    }
    setPaneHeaderSlot(document.getElementById(PROPERTIES_PANE_HEADER_SLOT_ID));
  }, [inline]);

  // Older clients persisted an empty Plan tab merely because the task was in
  // planning mode. Remove that stale tab once the plan lookup confirms there
  // is no document; a real plan will be opened by the materialization effect
  // below when it arrives.
  useEffect(() => {
    if (planDocument !== null || !controller.tabs.some((tab) => tab.id === "document:plan")) return;
    autoPlanHandledRef.current = false;
    controller.closeTab("document:plan");
  }, [controller.closeTab, controller.tabs, planDocument]);

  // Surface a newly materialized plan exactly once until the user takes manual
  // control of the tab set. Persisted empty/custom states therefore stay put.
  useEffect(() => {
    if (!planDocument || autoPlanHandledRef.current || userInteractedRef.current) return;
    autoPlanHandledRef.current = true;
    controller.openTab(taskPanelDocumentTab("plan", documentDisplayTitle(planDocument)));
  }, [controller.openTab, planDocument]);

  useEffect(() => {
    if (!documentDeepLink) return;
    if (
      documentDeepLink.documentKey === "plan" &&
      planDocument === null
    ) return;
    const document = documents.find((candidate) => candidate.key === documentDeepLink.documentKey);
    const label = document ? documentDisplayTitle(document) : documentDeepLink.documentKey === "plan" ? "Plan" : documentDeepLink.documentKey;
    controller.openTab(taskPanelDocumentTab(documentDeepLink.documentKey, label));
  }, [controller.openTab, documentDeepLink, documents, planDocument]);

  // Existing URL-backed workspace links remain the external integration API.
  useEffect(() => {
    if (!fileTabsEnabled) return;
    if (viewer.state) {
      controller.openTab(taskPanelWorkspaceFileTab(viewer.state));
    } else if (viewer.browse) {
      controller.openTab(taskPanelFilesTab());
      controller.updateTab("files", {
        payload: {
          kind: "files-browser",
          query: viewer.query,
          folderPath: viewer.folderPath,
          projectId: viewer.browseProjectId,
          workspaceId: viewer.browseWorkspaceId,
        },
      });
    }
  }, [
    controller.openTab,
    controller.updateTab,
    fileTabsEnabled,
    viewer.browse,
    viewer.browseProjectId,
    viewer.browseWorkspaceId,
    viewer.folderPath,
    viewer.query,
    viewer.state,
  ]);

  const recentFilesQuery = useQuery({
    queryKey: queryKeys.issues.fileResources(issue.id, {
      workspace: "auto",
      mode: "recent",
      limit: 5,
      offset: 0,
    }),
    queryFn: () => fileResourcesApi.list(issue.id, { workspace: "auto", mode: "recent", limit: 5, offset: 0 }),
    enabled: fileTabsEnabled && (launcherOpen || !activeTab),
    retry: false,
    staleTime: 15_000,
  });

  function markInteracted() {
    userInteractedRef.current = true;
  }

  function captureScroll() {
    if (controller.activeTabId && bodyRef.current) {
      scrollPositionsRef.current.set(controller.activeTabId, bodyRef.current.scrollTop);
    }
  }

  function selectTab(tabId: string) {
    captureScroll();
    markInteracted();
    controller.selectTab(tabId);
    const tab = controller.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (tab.payload.kind === "workspace-file") {
      viewer.open(tab.payload);
    } else if (tab.payload.kind === "files-browser") {
      viewer.openBrowse({ q: tab.payload.query ?? undefined });
    } else if (viewer.state || viewer.browse) {
      viewer.close();
    }
  }

  useEffect(() => {
    const top = controller.activeTabId ? scrollPositionsRef.current.get(controller.activeTabId) ?? 0 : 0;
    window.requestAnimationFrame(() => bodyRef.current?.scrollTo({ top, behavior: "auto" }));
  }, [controller.activeTabId]);

  useEffect(() => {
    if (activeTab) return;
    window.requestAnimationFrame(() => {
      bodyRef.current?.querySelector<HTMLInputElement>('input[aria-label="Search tabs and resources…"]')?.focus();
    });
  }, [activeTab]);

  function closeTab(tabId: string) {
    markInteracted();
    if (tabId === "subtasks") subtasksDismissedRef.current = true;
    const tab = controller.tabs.find((candidate) => candidate.id === tabId);
    controller.closeTab(tabId);
    if (tabId === controller.activeTabId && (tab?.payload.kind === "workspace-file" || tab?.payload.kind === "files-browser")) {
      viewer.close();
    }
  }

  function openDocument(document: Pick<IssueDocument, "key" | "title">) {
    markInteracted();
    controller.openTab(taskPanelDocumentTab(document.key, documentDisplayTitle(document)));
  }

  function openWorkspaceFile(ref: {
    path: string;
    workspace: "auto" | "execution" | "project";
    line?: number | null;
    column?: number | null;
    projectId?: string | null;
    workspaceId?: string | null;
  }) {
    markInteracted();
    const tab = taskPanelWorkspaceFileTab(ref);
    controller.openTab(tab);
    viewer?.open({
      ...ref,
      projectId: ref.projectId ?? null,
      workspaceId: ref.workspaceId ?? null,
      line: ref.line ?? null,
      column: ref.column ?? null,
    }, { fromBrowse: true });
  }

  const documentByKey = useMemo(() => new Map(documents.map((document) => [document.key, document])), [documents]);
  const visualTabs = useMemo<SidePanelTabItem[]>(() => controller.tabs.map((tab) => {
    const document = tab.payload.kind === "issue-document" ? documentByKey.get(tab.payload.documentKey) : null;
    return {
      id: tab.id,
      type: tab.type,
      label: document ? documentDisplayTitle(document) : tab.label,
      ariaLabel: tab.payload.kind === "subtasks" ? "Subtasks" : tab.ariaLabel,
      closable: true,
      contentMode: tab.contentMode,
      icon: tabIcon(tab),
    };
  }), [controller.tabs, documentByKey]);

  const launcherSections = useMemo<SidePanelLauncherSection[]>(() => {
    const primary: SidePanelLauncherItem[] = [
      { id: "properties", label: "Properties", icon: <SlidersHorizontal />, alreadyOpen: controller.tabs.some((tab) => tab.id === "properties") },
      ...(subtasksAvailable ? [{ id: "subtasks", label: "Subtasks", description: `${childIssues.length} total`, icon: <ListTree />, alreadyOpen: controller.tabs.some((tab) => tab.id === "subtasks") }] : []),
      { id: "artifacts", label: "Artifacts", icon: <Box />, alreadyOpen: controller.tabs.some((tab) => tab.id === "artifacts") },
    ];
    if (fileTabsEnabled) {
      primary.push({ id: "files", label: "Files", icon: <FolderOpen />, shortcut: "G F", alreadyOpen: controller.tabs.some((tab) => tab.id === "files") });
    }
    const documentItems: SidePanelLauncherItem[] = [
      ...(planDocument ? [{
        id: "document:plan",
        label: documentDisplayTitle(planDocument),
        description: `Revision ${planDocument.latestRevisionNumber ?? 1}`,
        icon: <Lightbulb />,
        alreadyOpen: controller.tabs.some((tab) => tab.id === "document:plan"),
      }] : []),
      ...documents
        .filter((document) => document.key !== "plan" && !isArtifactReviewDocumentKey(document.key))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        .map((document) => ({
          id: `document:${document.key}`,
          label: documentDisplayTitle(document),
          description: `Revision ${document.latestRevisionNumber ?? 1}`,
          icon: <FileText />,
          alreadyOpen: controller.tabs.some((tab) => tab.id === `document:${document.key}`),
        })),
    ];
    const sections: SidePanelLauncherSection[] = [
      { id: "open", label: "Open", items: primary },
    ];
    if (documentItems.length > 0) {
      sections.push({ id: "documents", label: "Task documents", items: documentItems });
    }
    if (fileTabsEnabled) {
      const recentItems = recentFilesQuery.data?.state === "available"
        ? recentFilesQuery.data.items.filter((item) => item.kind === "file").slice(0, 5).map((item) => ({
            id: `recent-file:${item.workspaceId}:${item.relativePath}`,
            label: item.title,
            description: item.displayPath,
            searchText: item.relativePath,
            icon: <FileCode2 />,
          }))
        : [];
      sections.push({
        id: "recent-files",
        label: "Recent workspace files",
        items: recentItems,
        loading: recentFilesQuery.isLoading,
        error: recentFilesQuery.isError ? "Recent files are temporarily unavailable." : null,
      });
    }
    return sections;
  }, [childIssues.length, controller.tabs, documents, fileTabsEnabled, planDocument, recentFilesQuery.data, recentFilesQuery.isError, recentFilesQuery.isLoading, subtasksAvailable]);

  function selectLauncherItem(item: SidePanelLauncherItem) {
    markInteracted();
    if (item.id === "properties") controller.openTab(taskPanelPropertiesTab());
    else if (item.id === "subtasks") {
      subtasksDismissedRef.current = false;
      controller.resetTabs({
        tabs: insertSubtasksAfterProperties(controller.tabs),
        activeTabId: "subtasks",
      });
    }
    else if (item.id === "artifacts") controller.openTab(taskPanelArtifactsTab());
    else if (item.id === "files") {
      controller.openTab(taskPanelFilesTab());
      viewer.openBrowse();
    } else if (item.id.startsWith("document:")) {
      const key = item.id.slice("document:".length);
      controller.openTab(taskPanelDocumentTab(key, item.label));
    } else if (item.id.startsWith("recent-file:") && recentFilesQuery.data?.state === "available") {
      const recent = recentFilesQuery.data.items.find((candidate) =>
        item.id === `recent-file:${candidate.workspaceId}:${candidate.relativePath}`,
      );
      if (recent?.kind === "file") {
        openWorkspaceFile({
          path: recent.relativePath,
          workspace: selectorForWorkspaceKind(recent.workspaceKind),
          projectId: recent.projectId ?? null,
          workspaceId: recent.workspaceId,
        });
      }
    }
  }

  const launcherControl = (
    <SidePanelLauncher
      sections={launcherSections}
      onSelect={selectLauncherItem}
      presentation="popover"
      open={launcherOpen}
      onOpenChange={setLauncherOpen}
      trigger={(
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground",
            streamlinedTabs
              ? "h-(--side-panel-tab-height) w-(--side-panel-tab-height) rounded-md"
              : "h-(--side-panel-tab-height) w-(--side-panel-tab-height) rounded-(--side-panel-control-radius)",
          )}
          aria-label="Open a new tab"
        >
          <Plus aria-hidden />
        </Button>
      )}
    />
  );
  const tabStrip = (
    <SidePanelTabs
      tabs={visualTabs}
      activeTabId={controller.activeTabId}
      onActiveTabChange={selectTab}
      onCloseTab={closeTab}
      onReorderTabs={(ordered) => {
        markInteracted();
        controller.reorderTabs(ordered);
      }}
      addControl={launcherControl}
      appearance={streamlinedTabs ? "streamlined-task" : "default"}
    />
  );

  let content: ReactNode;
  if (!activeTab) {
    content = <SidePanelLauncher sections={launcherSections} onSelect={selectLauncherItem} />;
  } else if (activeTab.payload.kind === "properties") {
    content = (
      <IssueProperties
        issue={issue}
        childIssues={childIssues}
        issueLinkState={issueLinkState}
        onAddSubIssue={onAddSubIssue}
        onUpdate={onUpdate}
        inline={inline}
        hasActiveRun={hasActiveRun}
        externalObjects={externalObjects}
        externalObjectsLoading={externalObjectsLoading}
        externalObjectsError={externalObjectsError}
        onRetryExternalObjects={onRetryExternalObjects}
        onCheckMonitorNow={onCheckMonitorNow}
        checkingMonitorNow={checkingMonitorNow}
        sidePanelContentOnly
      />
    );
  } else if (activeTab.payload.kind === "subtasks") {
    content = (
      <TaskDetailSubtasksPanel
        items={childIssues}
        onAddSubtask={onAddSubIssue}
        issueLinkState={issueLinkState}
      />
    );
  } else if (activeTab.payload.kind === "artifacts") {
    content = <IssuePropertiesArtifactsTab issue={issue} onOpenDocument={openDocument} />;
  } else if (activeTab.payload.kind === "issue-document") {
    content = activeTab.payload.documentKey === "plan" ? (
      <IssuePropertiesPlansTab issue={issue} inline={inline} />
    ) : (
      <TaskDocumentPanel
        issueId={issue.id}
        documentKey={activeTab.payload.documentKey}
        initialDocument={documentByKey.get(activeTab.payload.documentKey)}
      />
    );
  } else if (activeTab.payload.kind === "files-browser") {
    content = (
      <WorkspaceFileBrowser
        issueId={issue.id}
        companyId={issue.companyId}
        onOpen={openWorkspaceFile}
        onBrowseStateChange={(next) => {
          controller.updateTab(activeTab.id, {
            payload: {
              kind: "files-browser",
              query: next.q,
              folderPath: next.folderPath,
              projectId: next.projectId,
              workspaceId: next.workspaceId,
            },
          });
          viewer.updateBrowseState(next);
        }}
        initialQuery={activeTab.payload.query}
        initialFolderPath={activeTab.payload.folderPath}
        initialProjectId={activeTab.payload.projectId}
        initialWorkspaceId={activeTab.payload.workspaceId}
        active
        className="h-full min-h-0 p-3"
      />
    );
  } else {
    const filePayload = activeTab.payload;
    content = (
      <TaskWorkspaceFilePanel
        issueId={issue.id}
        payload={filePayload}
        onFallbackToProject={filePayload.workspace !== "project" && !filePayload.projectId && !filePayload.workspaceId
          ? () => openWorkspaceFile({ ...filePayload, workspace: "project" })
          : undefined}
      />
    );
  }

  const contentMode = activeTab?.contentMode ?? "full-bleed";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {paneHeaderSlot ? createPortal(tabStrip, paneHeaderSlot) : (
        <div className="flex h-(--side-panel-header-height) shrink-0 items-center gap-1 px-2">
          {tabStrip}
          {onRequestClose ? (
            <SidePanelToggleButton open onToggle={onRequestClose} />
          ) : null}
        </div>
      )}
      <div
        ref={bodyRef}
        data-side-panel-content-viewport="true"
        onScroll={handleScroll}
        role={activeTab ? "tabpanel" : undefined}
        id={activeTab ? `side-panel-content-${activeTab.id}` : undefined}
        aria-labelledby={activeTab ? `side-panel-tab-${activeTab.id}` : undefined}
        className={cn(
          "min-h-0 flex-1",
          contentMode === "full-bleed" ? "overflow-hidden" : "overflow-auto",
          contentMode !== "full-bleed" && "scrollbar-while-scrolling",
          contentMode === "padded" && "p-4",
        )}
      >
        {contentMode === "prose" ? (
          <div data-side-panel-prose-content="true" className="mx-auto w-full max-w-4xl px-6 py-4">
            {content}
          </div>
        ) : content}
      </div>
    </div>
  );
}
