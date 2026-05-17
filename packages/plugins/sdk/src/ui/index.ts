/**
 * `@paperclipai/plugin-sdk/ui` — Paperclip plugin UI SDK.
 *
 * Import this subpath from plugin UI bundles (React components that run in
 * the host frontend).  Do **not** import this from plugin worker code.
 *
 * The worker-side SDK is available from `@paperclipai/plugin-sdk` (root).
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 *
 * @example
 * ```tsx
 * // Plugin UI bundle entry (dist/ui/index.tsx)
 * import { usePluginData, usePluginAction } from "@paperclipai/plugin-sdk/ui";
 * import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
 *
 * export function DashboardWidget({ context }: PluginWidgetProps) {
 *   const { data, loading, error } = usePluginData("sync-health", {
 *     companyId: context.companyId,
 *   });
 *   const resync = usePluginAction("resync");
 *
 *   if (loading) return <div>Loading…</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <div style={{ display: "grid", gap: 8 }}>
 *       <strong>Synced Issues</strong>
 *       <div>{data!.syncedCount}</div>
 *       <button onClick={() => resync({ companyId: context.companyId })}>
 *         Resync Now
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */

/**
 * Bridge hooks for plugin UI components to communicate with the plugin worker.
 *
 * - `usePluginData(key, params)` — fetch data from the worker's `getData` handler
 * - `usePluginAction(key)` — get a callable that invokes the worker's `performAction` handler
 * - `useHostContext()` — read the current active company, project, entity, and user IDs
 * - `useHostNavigation()` — navigate Paperclip-internal links through the host router
 * - `useHostLocation()` — observe the current host pathname/search/hash for URL-driven UI
 * - `usePluginStream(channel)` — subscribe to real-time SSE events from the worker
 */
export {
  usePluginData,
  usePluginAction,
  useHostContext,
  useHostNavigation,
  useHostLocation,
  usePluginStream,
  usePluginToast,
} from "./hooks.js";

export {
  MetricCard,
  StatusBadge,
  DataTable,
  TimeseriesChart,
  MarkdownBlock,
  MarkdownEditor,
  KeyValueList,
  ActionBar,
  LogView,
  JsonTree,
  Spinner,
  ErrorBoundary,
  FileTree,
  IssuesList,
  AssigneePicker,
  ProjectPicker,
  ManagedRoutinesList,
} from "./components.js";

export type {
  MetricTrend,
  MetricCardProps,
  StatusBadgeVariant,
  StatusBadgeProps,
  DataTableColumn,
  DataTableProps,
  TimeseriesDataPoint,
  TimeseriesChartProps,
  MarkdownBlockProps,
  MarkdownEditorProps,
  KeyValuePair,
  KeyValueListProps,
  ActionBarItem,
  ActionBarProps,
  LogViewEntry,
  LogViewProps,
  JsonTreeProps,
  SpinnerProps,
  ErrorBoundaryProps,
  FileTreeNode,
  FileTreeBadgeVariant,
  FileTreeBadge,
  FileTreeTone,
  FileTreeEmptyState,
  FileTreeErrorState,
  FileTreePathCollection,
  FileTreeProps,
  IssuesListFilters,
  IssuesListProps,
  AssigneePickerSelection,
  AssigneePickerProps,
  ProjectPickerProps,
  ManagedRoutineMissingRef,
  ManagedRoutinesListAgent,
  ManagedRoutinesListItem,
  ManagedRoutinesListProject,
  ManagedRoutinesListProps,
} from "./components.js";

// Bridge error and host context types
export type {
  PluginBridgeError,
  PluginBridgeErrorCode,
  HostNavigation,
  HostNavigationOptions,
  HostNavigationLinkOptions,
  HostNavigationLinkProps,
  HostLocation,
  PluginHostContext,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
  PluginRenderCloseHandler,
  PluginRenderCloseLifecycle,
  PluginRenderEnvironmentContext,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
  PluginDataResult,
  PluginActionFn,
  PluginStreamResult,
  PluginToastTone,
  PluginToastAction,
  PluginToastInput,
  PluginToastFn,
} from "./types.js";

// Slot component prop interfaces
export type {
  PluginPageProps,
  PluginWidgetProps,
  PluginDetailTabProps,
  PluginSidebarProps,
  PluginRouteSidebarProps,
  PluginProjectSidebarItemProps,
  PluginCommentAnnotationProps,
  PluginCommentContextMenuItemProps,
  PluginSettingsPageProps,
} from "./types.js";
