/**
 * Shared UI component declarations for plugin frontends.
 *
 * These components are exported from `@paperclipai/plugin-sdk/ui` and are
 * provided by the host at runtime.  They match the host's design tokens and
 * visual language, reducing the boilerplate needed to build consistent plugin UIs.
 *
 * **Plugins are not required to use these components.**  They exist to reduce
 * boilerplate and keep visual consistency. A plugin may render entirely custom
 * UI using any React component library.
 *
 * Component implementations are provided by the host — plugin bundles contain
 * only the type declarations; the runtime implementations are injected via the
 * host module registry.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components In `@paperclipai/plugin-sdk/ui`
 */

import type React from "react";
import { renderSdkUiComponent } from "./runtime.js";

// ---------------------------------------------------------------------------
// Component prop interfaces
// ---------------------------------------------------------------------------

/**
 * A trend value that can accompany a metric.
 * Positive values indicate upward trends; negative values indicate downward trends.
 */
export interface MetricTrend {
  /** Direction of the trend. */
  direction: "up" | "down" | "flat";
  /** Percentage change value (e.g. `12.5` for 12.5%). */
  percentage?: number;
}

/** Props for `MetricCard`. */
export interface MetricCardProps {
  /** Short label describing the metric (e.g. `"Synced Issues"`). */
  label: string;
  /** The metric value to display. */
  value: number | string;
  /** Optional trend indicator. */
  trend?: MetricTrend;
  /** Optional sparkline data (array of numbers, latest last). */
  sparkline?: number[];
  /** Optional unit suffix (e.g. `"%"`, `"ms"`). */
  unit?: string;
}

/** Status variants for `StatusBadge`. */
export type StatusBadgeVariant = "ok" | "warning" | "error" | "info" | "pending";

/** Props for `StatusBadge`. */
export interface StatusBadgeProps {
  /** Human-readable label. */
  label: string;
  /** Visual variant determining colour. */
  status: StatusBadgeVariant;
}

/** A single column definition for `DataTable`. */
export interface DataTableColumn<T = Record<string, unknown>> {
  /** Column key, matching a field on the row object. */
  key: keyof T & string;
  /** Column header label. */
  header: string;
  /** Optional custom cell renderer. */
  render?: (value: unknown, row: T) => React.ReactNode;
  /** Whether this column is sortable. */
  sortable?: boolean;
  /** CSS width (e.g. `"120px"`, `"20%"`). */
  width?: string;
}

/** Props for `DataTable`. */
export interface DataTableProps<T = Record<string, unknown>> {
  /** Column definitions. */
  columns: DataTableColumn<T>[];
  /** Row data. Each row should have a stable `id` field. */
  rows: T[];
  /** Whether the table is currently loading. */
  loading?: boolean;
  /** Message shown when `rows` is empty. */
  emptyMessage?: string;
  /** Total row count for pagination (if different from `rows.length`). */
  totalCount?: number;
  /** Current page (0-based, for pagination). */
  page?: number;
  /** Rows per page (for pagination). */
  pageSize?: number;
  /** Callback when page changes. */
  onPageChange?: (page: number) => void;
  /** Callback when a column header is clicked to sort. */
  onSort?: (key: string, direction: "asc" | "desc") => void;
}

/** A single data point for `TimeseriesChart`. */
export interface TimeseriesDataPoint {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Numeric value. */
  value: number;
  /** Optional label for the point. */
  label?: string;
}

/** Props for `TimeseriesChart`. */
export interface TimeseriesChartProps {
  /** Series data. */
  data: TimeseriesDataPoint[];
  /** Chart title. */
  title?: string;
  /** Y-axis label. */
  yLabel?: string;
  /** Chart type. Defaults to `"line"`. */
  type?: "line" | "bar";
  /** Height of the chart in pixels. Defaults to `200`. */
  height?: number;
  /** Whether the chart is currently loading. */
  loading?: boolean;
}

/** Props for `MarkdownBlock`. */
export interface MarkdownBlockProps {
  /** Markdown content to render. */
  content: string;
  /** Optional CSS class name forwarded to the host renderer. */
  className?: string;
  /** Opt into Obsidian-style [[target]] / [[target|label]] wikilinks. */
  enableWikiLinks?: boolean;
  /** Base href used for wikilinks when no resolver is supplied. */
  wikiLinkRoot?: string;
  /** Optional href resolver for wikilinks. Return null to leave a token as plain text. */
  resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
}

/** Props for `MarkdownEditor`. */
export interface MarkdownEditorProps {
  /** Markdown source controlled by the plugin. */
  value: string;
  /** Called whenever the markdown source changes. */
  onChange: (value: string) => void;
  /** Placeholder text shown when the document is empty. */
  placeholder?: string;
  /** Optional wrapper CSS class name. */
  className?: string;
  /** Optional editable content CSS class name. */
  contentClassName?: string;
  /** Called when the editor loses focus. */
  onBlur?: () => void;
  /** Render the editor with a host border treatment. */
  bordered?: boolean;
  /** Render the rich editor without allowing edits. */
  readOnly?: boolean;
  /** Called on Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
}

/** A single key-value pair for `KeyValueList`. */
export interface KeyValuePair {
  /** Label for the key. */
  label: string;
  /** Value to display. May be a string, number, or a React node. */
  value: React.ReactNode;
}

/** Props for `KeyValueList`. */
export interface KeyValueListProps {
  /** Pairs to render in the list. */
  pairs: KeyValuePair[];
}

/** A single action button for `ActionBar`. */
export interface ActionBarItem {
  /** Button label. */
  label: string;
  /** Action key to call via the plugin bridge. */
  actionKey: string;
  /** Optional parameters to pass to the action handler. */
  params?: Record<string, unknown>;
  /** Button variant. Defaults to `"default"`. */
  variant?: "default" | "primary" | "destructive";
  /** Whether to show a confirmation dialog before executing. */
  confirm?: boolean;
  /** Text for the confirmation dialog (used when `confirm` is true). */
  confirmMessage?: string;
}

/** Props for `ActionBar`. */
export interface ActionBarProps {
  /** Action definitions. */
  actions: ActionBarItem[];
  /** Called after an action succeeds. Use to trigger data refresh. */
  onSuccess?: (actionKey: string, result: unknown) => void;
  /** Called when an action fails. */
  onError?: (actionKey: string, error: unknown) => void;
}

/** A single log line for `LogView`. */
export interface LogViewEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Log level. */
  level: "info" | "warn" | "error" | "debug";
  /** Log message. */
  message: string;
  /** Optional structured metadata. */
  meta?: Record<string, unknown>;
}

/** Props for `LogView`. */
export interface LogViewProps {
  /** Log entries to display. */
  entries: LogViewEntry[];
  /** Maximum height of the scrollable container (CSS value). Defaults to `"400px"`. */
  maxHeight?: string;
  /** Whether to auto-scroll to the latest entry. */
  autoScroll?: boolean;
  /** Whether the log is currently loading. */
  loading?: boolean;
}

/** Props for `JsonTree`. */
export interface JsonTreeProps {
  /** The data to render as a collapsible JSON tree. */
  data: unknown;
  /** Initial depth to expand. Defaults to `2`. */
  defaultExpandDepth?: number;
}

/** Props for `Spinner`. */
export interface SpinnerProps {
  /** Size of the spinner. Defaults to `"md"`. */
  size?: "sm" | "md" | "lg";
  /** Accessible label for the spinner (used as `aria-label`). */
  label?: string;
}

/** Props for `ErrorBoundary`. */
export interface ErrorBoundaryProps {
  /** Content to render inside the error boundary. */
  children: React.ReactNode;
  /** Optional custom fallback to render when an error is caught. */
  fallback?: React.ReactNode;
  /** Called when an error is caught, for logging or reporting. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

/** File or directory node rendered by `FileTree`. */
export interface FileTreeNode {
  /** Display name for this path segment. */
  name: string;
  /** Slash-separated path relative to the tree root. */
  path: string;
  /** Whether this node is a directory or file. */
  kind: "dir" | "file";
  /** Child nodes. Files should use an empty array. */
  children: FileTreeNode[];
  /** Optional stable action metadata for host/plugin workflows. */
  action?: string | null;
}

/** Badge status variants supported by `FileTree`. */
export type FileTreeBadgeVariant = "ok" | "warning" | "error" | "info" | "pending";

/** Serializable badge metadata keyed by file path. */
export interface FileTreeBadge {
  label: string;
  status: FileTreeBadgeVariant;
  tooltip?: string;
}

/** Row tone variants supported by `FileTree`. */
export type FileTreeTone = "default" | "warning" | "error" | "muted";

/** Empty-state content shown when a tree has no nodes. */
export interface FileTreeEmptyState {
  title?: string;
  description?: string;
}

/** Error-state content shown when a tree cannot be loaded. */
export interface FileTreeErrorState {
  message: string;
  retry?: () => void;
}

/** Accepted path collection shape for expanded and checked file tree state. */
export type FileTreePathCollection = ReadonlySet<string> | readonly string[];

/** Props for `FileTree`. */
export interface FileTreeProps {
  /** Tree nodes to render. */
  nodes: FileTreeNode[];
  /** Currently selected file path. */
  selectedFile?: string | null;
  /** Expanded directory paths. */
  expandedPaths?: FileTreePathCollection;
  /** Checked file paths. */
  checkedPaths?: FileTreePathCollection;
  /** Called when a directory row is toggled. */
  onToggleDir?: (path: string) => void;
  /** Called when a file row is selected. */
  onSelectFile?: (path: string) => void;
  /** Called when a checkbox is toggled. */
  onToggleCheck?: (path: string, kind: "file" | "dir") => void;
  /** Badge metadata keyed by path. */
  fileBadges?: Record<string, FileTreeBadge | undefined>;
  /** Row tone metadata keyed by path. */
  fileTones?: Record<string, FileTreeTone | undefined>;
  /** Whether to render checkboxes. Defaults to false for plugin UIs. */
  showCheckboxes?: boolean;
  /** Allow long file and directory names to wrap. */
  wrapLabels?: boolean;
  /** Render a loading skeleton instead of nodes. */
  loading?: boolean;
  /** Render a structured error state instead of nodes. */
  error?: FileTreeErrorState | null;
  /** Empty state content. */
  empty?: FileTreeEmptyState;
  /** Accessible label for the tree. */
  ariaLabel?: string;
}

export interface IssuesListFilters {
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
}

export interface IssuesListProps {
  companyId: string | null;
  projectId?: string | null;
  filters?: IssuesListFilters;
  viewStateKey?: string;
  initialSearch?: string;
  createIssueLabel?: string;
  searchWithinLoadedIssues?: boolean;
}

export interface AssigneePickerSelection {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AssigneePickerProps {
  /** Company whose agents and users should be listed. Defaults to host context. */
  companyId?: string | null;
  /** Controlled value. Use `agent:<id>`, `user:<id>`, or an empty string. */
  value: string;
  /** Called with the encoded value plus parsed assignee IDs. */
  onChange: (value: string, selection: AssigneePickerSelection) => void;
  /** Button placeholder when no assignee is selected. */
  placeholder?: string;
  /** Label for the empty option. */
  noneLabel?: string;
  /** Search input placeholder. */
  searchPlaceholder?: string;
  /** Empty search result message. */
  emptyMessage?: string;
  /** Include active board users alongside agents. Defaults to true. */
  includeUsers?: boolean;
  /** Include terminated agents. Defaults to false. */
  includeTerminatedAgents?: boolean;
  /** CSS class forwarded to the trigger button. */
  className?: string;
  /** Called after the user confirms a selection with Enter, Tab, or click. */
  onConfirm?: () => void;
}

export interface ProjectPickerProps {
  /** Company whose projects should be listed. Defaults to host context. */
  companyId?: string | null;
  /** Controlled project id, or an empty string for no project. */
  value: string;
  /** Called with the selected project id. Empty string means no project. */
  onChange: (projectId: string) => void;
  /** Button placeholder when no project is selected. */
  placeholder?: string;
  /** Label for the empty option. */
  noneLabel?: string;
  /** Search input placeholder. */
  searchPlaceholder?: string;
  /** Empty search result message. */
  emptyMessage?: string;
  /** Include archived projects. Defaults to false. */
  includeArchived?: boolean;
  /** CSS class forwarded to the trigger button. */
  className?: string;
  /** Called after the user confirms a selection with Enter, Tab, or click. */
  onConfirm?: () => void;
}

export interface ManagedRoutinesListAgent {
  id: string;
  name: string;
  icon?: string | null;
}

export interface ManagedRoutinesListProject {
  id: string;
  name: string;
  color?: string | null;
}

export interface ManagedRoutineMissingRef {
  resourceKind: string;
  resourceKey: string;
}

export interface ManagedRoutinesListItem {
  key: string;
  title: string;
  status: string;
  routineId?: string | null;
  href?: string | null;
  resourceKey?: string | null;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  cronExpression?: string | null;
  lastRunAt?: Date | string | null;
  lastRunStatus?: string | null;
  managedByPluginDisplayName?: string | null;
  missingRefs?: ManagedRoutineMissingRef[];
}

export interface ManagedRoutinesListProps {
  routines: ManagedRoutinesListItem[];
  agents?: ManagedRoutinesListAgent[];
  projects?: ManagedRoutinesListProject[];
  pluginDisplayName?: string | null;
  emptyMessage?: string;
  runningRoutineKey?: string | null;
  statusMutationRoutineKey?: string | null;
  reconcilingRoutineKey?: string | null;
  resettingRoutineKey?: string | null;
  onRunNow?: (routine: ManagedRoutinesListItem) => void;
  onToggleEnabled?: (routine: ManagedRoutinesListItem, enabled: boolean) => void;
  onReconcile?: (routine: ManagedRoutinesListItem) => void;
  onReset?: (routine: ManagedRoutinesListItem) => void;
}

// ---------------------------------------------------------------------------
// Component declarations (provided by host at runtime)
// ---------------------------------------------------------------------------

// These are declared as ambient values so plugin TypeScript code can import
// and use them with full type-checking. The host's module registry provides
// the concrete React component implementations at bundle load time.

/**
 * Displays a single metric with an optional trend indicator and sparkline.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
function createSdkUiComponent<TProps>(name: string): React.ComponentType<TProps> {
  return function PaperclipSdkUiComponent(props: TProps) {
    return renderSdkUiComponent(name, props) as React.ReactNode;
  };
}

export const MetricCard = createSdkUiComponent<MetricCardProps>("MetricCard");

/**
 * Displays an inline status badge (ok / warning / error / info / pending).
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const StatusBadge = createSdkUiComponent<StatusBadgeProps>("StatusBadge");

/**
 * Sortable, paginated data table.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const DataTable = createSdkUiComponent<DataTableProps>("DataTable");

/**
 * Line or bar chart for time-series data.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const TimeseriesChart = createSdkUiComponent<TimeseriesChartProps>("TimeseriesChart");

/**
 * Renders Markdown text as HTML.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const MarkdownBlock = createSdkUiComponent<MarkdownBlockProps>("MarkdownBlock");

/**
 * Renders Paperclip's shared Markdown editor.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const MarkdownEditor = createSdkUiComponent<MarkdownEditorProps>("MarkdownEditor");

/**
 * Renders a definition-list of label/value pairs.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const KeyValueList = createSdkUiComponent<KeyValueListProps>("KeyValueList");

/**
 * Row of action buttons wired to the plugin bridge's `performAction` handlers.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const ActionBar = createSdkUiComponent<ActionBarProps>("ActionBar");

/**
 * Scrollable, timestamped log output viewer.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const LogView = createSdkUiComponent<LogViewProps>("LogView");

/**
 * Collapsible JSON tree for debugging or raw data inspection.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const JsonTree = createSdkUiComponent<JsonTreeProps>("JsonTree");

/**
 * Loading indicator.
 *
 * @see PLUGIN_SPEC.md §19.6 — Shared Components
 */
export const Spinner = createSdkUiComponent<SpinnerProps>("Spinner");

/**
 * React error boundary that prevents plugin rendering errors from crashing
 * the host page.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export const ErrorBoundary = createSdkUiComponent<ErrorBoundaryProps>("ErrorBoundary");

/**
 * Renders the host file tree component with a stable plugin-safe prop surface.
 *
 * @example
 * ```tsx
 * import { FileTree, type FileTreeNode } from "@paperclipai/plugin-sdk/ui";
 *
 * const nodes: FileTreeNode[] = [
 *   { name: "README.md", path: "README.md", kind: "file", children: [] },
 * ];
 *
 * <FileTree nodes={nodes} onSelectFile={(path) => console.log(path)} />;
 * ```
 */
export const FileTree = createSdkUiComponent<FileTreeProps>("FileTree");

/**
 * Renders Paperclip's native issue list component for company-scoped plugin
 * pages that need a standard board issue view.
 */
export const IssuesList = createSdkUiComponent<IssuesListProps>("IssuesList");

/**
 * Renders the same host assignee picker used by the new issue pane.
 */
export const AssigneePicker = createSdkUiComponent<AssigneePickerProps>("AssigneePicker");

/**
 * Renders the same host project picker used by the new issue pane.
 */
export const ProjectPicker = createSdkUiComponent<ProjectPickerProps>("ProjectPicker");

/**
 * Renders Paperclip's native managed routines list for plugin settings pages.
 */
export const ManagedRoutinesList = createSdkUiComponent<ManagedRoutinesListProps>("ManagedRoutinesList");
