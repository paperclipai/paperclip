/**
 * Plugin bridge initialization.
 *
 * Registers the host's React instances and bridge hook implementations
 * on a global object so that the plugin module loader can inject them
 * into plugin UI bundles at load time.
 *
 * Call `initPluginBridge()` once during app startup (in `main.tsx`), before
 * any plugin UI modules are loaded.
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §19.0.2 — Bundle Isolation
 */

import {
  usePluginData,
  usePluginAction,
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginStream,
  usePluginToast,
} from "./bridge.js";
import { createElement, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { User } from "lucide-react";
import {
  FileTree,
  type FileTreeProps as HostFileTreeProps,
} from "@/components/FileTree";
import { AgentIcon } from "@/components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "@/components/InlineEntitySelector";
import { IssuesList as HostIssuesList } from "@/components/IssuesList";
import { ManagedRoutinesList as HostManagedRoutinesList } from "@/components/ManagedRoutinesList";
import { MarkdownBody } from "@/components/MarkdownBody";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import {
  buildCompanyUserInlineOptions,
} from "@/lib/company-members";
import { collectLiveIssueIds } from "@/lib/liveIssueIds";
import { useProjectOrder } from "@/hooks/useProjectOrder";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  parseAssigneeValue,
} from "@/lib/assignees";
import { queryKeys } from "@/lib/queryKeys";
import {
  getRecentAssigneeSelectionIds,
  sortAgentsByRecency,
  trackRecentAssignee,
  trackRecentAssigneeUser,
} from "@/lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "@/lib/recent-projects";

// ---------------------------------------------------------------------------
// Global bridge registry
// ---------------------------------------------------------------------------

/**
 * The global bridge registry shape.
 *
 * This is placed on `globalThis.__paperclipPluginBridge__` and consumed by
 * the plugin module loader to provide implementations for external imports.
 */
export interface PluginBridgeRegistry {
  react: unknown;
  reactDom: unknown;
  sdkUi: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __paperclipPluginBridge__: PluginBridgeRegistry | undefined;
}

type PluginFileTreePathCollection = ReadonlySet<string> | readonly string[];

type PluginFileTreeProps = Omit<
  HostFileTreeProps,
  | "expandedDirs"
  | "checkedFiles"
  | "renderFileExtra"
  | "fileRowClassName"
  | "selectedFile"
  | "showCheckboxes"
  | "onToggleDir"
  | "onSelectFile"
> & {
  selectedFile?: string | null;
  expandedPaths?: PluginFileTreePathCollection;
  checkedPaths?: PluginFileTreePathCollection;
  showCheckboxes?: boolean;
  onToggleDir?: (path: string) => void;
  onSelectFile?: (path: string) => void;
};

function toPathSet(paths?: PluginFileTreePathCollection | null): Set<string> {
  return new Set(paths ?? []);
}

function PluginSdkFileTree({
  expandedPaths,
  checkedPaths,
  selectedFile = null,
  showCheckboxes = false,
  onToggleDir,
  onSelectFile,
  ...props
}: PluginFileTreeProps) {
  return createElement(FileTree, {
    ...props,
    selectedFile,
    expandedDirs: toPathSet(expandedPaths),
    checkedFiles: checkedPaths ? toPathSet(checkedPaths) : undefined,
    showCheckboxes,
    onToggleDir: onToggleDir ?? (() => undefined),
    onSelectFile: onSelectFile ?? (() => undefined),
  });
}

type PluginMarkdownBlockProps = {
  content: string;
  className?: string;
  enableWikiLinks?: boolean;
  wikiLinkRoot?: string;
  resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
};

type PluginMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  onBlur?: () => void;
  bordered?: boolean;
  readOnly?: boolean;
  onSubmit?: () => void;
};

type PluginIssuesListFilters = {
  status?: string;
  projectId?: string;
  parentId?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  labelId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  descendantOf?: string;
  includeRoutineExecutions?: boolean;
};

type PluginIssuesListProps = {
  companyId: string | null;
  projectId?: string | null;
  filters?: PluginIssuesListFilters;
  viewStateKey?: string;
  initialSearch?: string;
  createIssueLabel?: string;
  searchWithinLoadedIssues?: boolean;
};

type PluginAssigneePickerSelection = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

type PluginAssigneePickerProps = {
  companyId?: string | null;
  value: string;
  onChange: (value: string, selection: PluginAssigneePickerSelection) => void;
  placeholder?: string;
  noneLabel?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  includeUsers?: boolean;
  includeTerminatedAgents?: boolean;
  className?: string;
  onConfirm?: () => void;
};

type PluginProjectPickerProps = {
  companyId?: string | null;
  value: string;
  onChange: (projectId: string) => void;
  placeholder?: string;
  noneLabel?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  includeArchived?: boolean;
  className?: string;
  onConfirm?: () => void;
};

function PluginSdkMarkdownEditor(props: PluginMarkdownEditorProps) {
  const [Editor, setEditor] = useState<ComponentType<PluginMarkdownEditorProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("@/components/MarkdownEditor").then((module) => {
      if (!cancelled) setEditor(() => module.MarkdownEditor as ComponentType<PluginMarkdownEditorProps>);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (Editor) return createElement(Editor, props);

  return createElement("textarea", {
    className: props.className,
    value: props.value,
    placeholder: props.placeholder,
    readOnly: props.readOnly,
    onBlur: props.onBlur,
    onChange: (event) => props.onChange((event.currentTarget as HTMLTextAreaElement).value),
  });
}

function compactIssueFilters(filters: PluginIssuesListFilters): PluginIssuesListFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) =>
      value !== undefined && value !== null && value !== "" && value !== false,
    ),
  ) as PluginIssuesListFilters;
}

function PluginSdkIssuesList({
  companyId,
  projectId = null,
  filters,
  viewStateKey = "paperclip:plugin-issues-view",
  initialSearch,
  createIssueLabel,
  searchWithinLoadedIssues = true,
}: PluginIssuesListProps) {
  const queryClient = useQueryClient();
  const issueFilters = useMemo(
    () => compactIssueFilters({
      ...(filters ?? {}),
      projectId: filters?.projectId ?? projectId ?? undefined,
    }),
    [filters, projectId],
  );
  const originKindPrefix = issueFilters.originKindPrefix ?? null;
  const resolvedProjectId = issueFilters.projectId ?? projectId ?? null;
  const issuesQueryKey = useMemo(
    () => ["plugins", "sdk-ui", "issues-list", companyId ?? "__no-company__", issueFilters] as const,
    [companyId, issueFilters],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? "__no-company__"),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId ?? "__no-company__"),
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId ?? "__no-company__"),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: !!companyId,
    refetchInterval: 5000,
  });
  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: issuesQueryKey,
    queryFn: () => issuesApi.list(companyId!, issueFilters),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      if (!companyId) return;
      queryClient.invalidateQueries({ queryKey: ["plugins", "sdk-ui", "issues-list", companyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      if (resolvedProjectId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, resolvedProjectId) });
        if (originKindPrefix) {
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.listPluginOperationsByProject(companyId, resolvedProjectId, originKindPrefix),
          });
        }
      }
    },
  });

  if (!companyId) {
    return createElement("div", { className: "text-sm text-muted-foreground" }, "Select a company to view issues.");
  }

  return createElement(HostIssuesList, {
    issues: issues ?? [],
    isLoading,
    error: error as Error | null,
    agents,
    projects,
    liveIssueIds,
    projectId: resolvedProjectId ?? undefined,
    viewStateKey,
    initialSearch,
    createIssueLabel,
    searchWithinLoadedIssues,
    onUpdateIssue: (id: string, data: Record<string, unknown>) => updateIssue.mutate({ id, data }),
  });
}

function PluginSdkAssigneePicker({
  companyId,
  value,
  onChange,
  placeholder = "Assignee",
  noneLabel = "No assignee",
  searchPlaceholder = "Search assignees...",
  emptyMessage = "No assignees found.",
  includeUsers = true,
  includeTerminatedAgents = false,
  className,
  onConfirm,
}: PluginAssigneePickerProps) {
  const hostContext = useHostContext();
  const resolvedCompanyId = companyId ?? hostContext.companyId ?? null;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: includeUsers,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? "__no-company__"),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(resolvedCompanyId ?? "__no-company__"),
    queryFn: () => accessApi.listUserDirectory(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && includeUsers,
  });
  const recentAssigneeSelectionIds = useMemo(() => getRecentAssigneeSelectionIds(), []);
  const recentAssigneeIds = useMemo(
    () => recentAssigneeSelectionIds
      .map((id) => id.startsWith("agent:") ? id.slice("agent:".length) : null)
      .filter((id): id is string => Boolean(id)),
    [recentAssigneeSelectionIds],
  );
  const sortedAgents = useMemo(
    () => sortAgentsByRecency(
      (agents ?? []).filter((agent) => includeTerminatedAgents || agent.status !== "terminated"),
      recentAssigneeIds,
    ),
    [agents, includeTerminatedAgents, recentAssigneeIds],
  );
  const options = useMemo<InlineEntityOption[]>(
    () => [
      ...(includeUsers ? currentUserAssigneeOption(currentUserId) : []),
      ...(includeUsers
        ? buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId] })
        : []),
      ...sortedAgents.map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [companyMembers?.users, currentUserId, includeUsers, sortedAgents],
  );
  const selectedAssignee = parseAssigneeValue(value);
  const selectedAgent = selectedAssignee.assigneeAgentId
    ? sortedAgents.find((agent) => agent.id === selectedAssignee.assigneeAgentId)
    : null;

  return createElement(InlineEntitySelector, {
    value,
    options,
    recentOptionIds: recentAssigneeSelectionIds,
    placeholder,
    noneLabel,
    searchPlaceholder,
    emptyMessage,
    className,
    onConfirm,
    onChange: (nextValue: string) => {
      const selection = parseAssigneeValue(nextValue);
      if (selection.assigneeAgentId) trackRecentAssignee(selection.assigneeAgentId);
      if (selection.assigneeUserId) trackRecentAssigneeUser(selection.assigneeUserId);
      onChange(nextValue, selection);
    },
    renderTriggerValue: (option: InlineEntityOption | null) => {
      if (!option) return createElement("span", { className: "text-muted-foreground" }, placeholder);
      if (selectedAgent) {
        return createElement(
          FragmentSafe,
          null,
          createElement(AgentIcon, { icon: selectedAgent.icon, className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
          createElement("span", { className: "truncate" }, option.label),
        );
      }
      return createElement("span", { className: "truncate" }, option.label);
    },
    renderOption: (option: InlineEntityOption) => {
      if (!option.id) return createElement("span", { className: "truncate" }, option.label);
      const selection = parseAssigneeValue(option.id);
      const agent = selection.assigneeAgentId
        ? sortedAgents.find((entry) => entry.id === selection.assigneeAgentId)
        : null;
      return createElement(
        FragmentSafe,
        null,
        agent
          ? createElement(AgentIcon, { icon: agent.icon, className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" })
          : createElement(User, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }),
        createElement("span", { className: "truncate" }, option.label),
      );
    },
  });
}

function PluginSdkProjectPicker({
  companyId,
  value,
  onChange,
  placeholder = "Project",
  noneLabel = "No project",
  searchPlaceholder = "Search projects...",
  emptyMessage = "No projects found.",
  includeArchived = false,
  className,
  onConfirm,
}: PluginProjectPickerProps) {
  const hostContext = useHostContext();
  const resolvedCompanyId = companyId ?? hostContext.companyId ?? null;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId ?? "__no-company__"),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });
  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => includeArchived || !project.archivedAt),
    [includeArchived, projects],
  );
  const { orderedProjects } = useProjectOrder({
    projects: visibleProjects,
    companyId: resolvedCompanyId,
    userId: currentUserId,
  });
  const recentProjectIds = useMemo(() => getRecentProjectIds(), []);
  const options = useMemo<InlineEntityOption[]>(
    () => orderedProjects.map((project) => ({
      id: project.id,
      label: project.name,
      searchText: project.description ?? "",
    })),
    [orderedProjects],
  );
  const selectedProject = orderedProjects.find((project) => project.id === value) ?? null;

  return createElement(InlineEntitySelector, {
    value,
    options,
    recentOptionIds: recentProjectIds,
    placeholder,
    noneLabel,
    searchPlaceholder,
    emptyMessage,
    className,
    onConfirm,
    onChange: (nextProjectId: string) => {
      if (nextProjectId) trackRecentProject(nextProjectId);
      onChange(nextProjectId);
    },
    renderTriggerValue: (option: InlineEntityOption | null) => {
      if (!option || !selectedProject) {
        return createElement("span", { className: "text-muted-foreground" }, placeholder);
      }
      return createElement(
        FragmentSafe,
        null,
        createElement("span", {
          className: "h-3.5 w-3.5 shrink-0 rounded-sm",
          style: { backgroundColor: selectedProject.color ?? "#6366f1" },
        }),
        createElement("span", { className: "truncate" }, option.label),
      );
    },
    renderOption: (option: InlineEntityOption) => {
      if (!option.id) return createElement("span", { className: "truncate" }, option.label);
      const project = orderedProjects.find((entry) => entry.id === option.id);
      return createElement(
        FragmentSafe,
        null,
        createElement("span", {
          className: "h-3.5 w-3.5 shrink-0 rounded-sm",
          style: { backgroundColor: project?.color ?? "#6366f1" },
        }),
        createElement("span", { className: "truncate" }, option.label),
      );
    },
  });
}

function FragmentSafe({ children }: { children?: ReactNode }) {
  return createElement("span", { className: "contents" }, children);
}

/**
 * Initialize the plugin bridge global registry.
 *
 * Registers the host's React, ReactDOM, and SDK UI bridge implementations
 * on `globalThis.__paperclipPluginBridge__` so the plugin module loader
 * can provide them to plugin bundles.
 *
 * @param react - The host's React module
 * @param reactDom - The host's ReactDOM module
 */
export function initPluginBridge(
  react: typeof import("react"),
  reactDom: typeof import("react-dom"),
): void {
  globalThis.__paperclipPluginBridge__ = {
    react,
    reactDom,
    sdkUi: {
      usePluginData,
      usePluginAction,
      useHostContext,
      useHostLocation,
      useHostNavigation,
      usePluginStream,
      usePluginToast,
      MarkdownBlock: ({
        content,
        className,
        enableWikiLinks,
        wikiLinkRoot,
        resolveWikiLinkHref,
      }: PluginMarkdownBlockProps) =>
        createElement(MarkdownBody, {
          className,
          softBreaks: false,
          enableWikiLinks,
          wikiLinkRoot,
          resolveWikiLinkHref,
          children: content,
        }),
      MarkdownEditor: PluginSdkMarkdownEditor,
      FileTree: PluginSdkFileTree,
      IssuesList: PluginSdkIssuesList,
      AssigneePicker: PluginSdkAssigneePicker,
      ProjectPicker: PluginSdkProjectPicker,
      ManagedRoutinesList: HostManagedRoutinesList,
    },
  };
}
