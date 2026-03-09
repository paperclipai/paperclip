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
 * import {
 *   usePluginData,
 *   usePluginAction,
 *   useHostContext,
 *   MetricCard,
 *   StatusBadge,
 *   Spinner,
 * } from "@paperclipai/plugin-sdk/ui";
 * import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
 *
 * export function DashboardWidget({ context }: PluginWidgetProps) {
 *   const { data, loading, error } = usePluginData("sync-health", {
 *     companyId: context.companyId,
 *   });
 *   const resync = usePluginAction("resync");
 *
 *   if (loading) return <Spinner />;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <div>
 *       <MetricCard label="Synced Issues" value={data!.syncedCount} />
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
 */
export {
  usePluginData,
  usePluginAction,
  useHostContext,
} from "./hooks.js";

// Bridge error and host context types
export type {
  PluginBridgeError,
  PluginBridgeErrorCode,
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
} from "./types.js";

// Slot component prop interfaces
export type {
  PluginPageProps,
  PluginWidgetProps,
  PluginDetailTabProps,
  PluginSidebarProps,
  PluginProjectSidebarItemProps,
  PluginSettingsPageProps,
} from "./types.js";

// Shared UI components
export {
  MetricCard,
  StatusBadge,
  DataTable,
  TimeseriesChart,
  MarkdownBlock,
  KeyValueList,
  ActionBar,
  LogView,
  JsonTree,
  Spinner,
  ErrorBoundary,
} from "./components.js";

// Shared component prop types (for plugin authors who need to extend them)
export type {
  MetricCardProps,
  MetricTrend,
  StatusBadgeProps,
  StatusBadgeVariant,
  DataTableProps,
  DataTableColumn,
  TimeseriesChartProps,
  TimeseriesDataPoint,
  MarkdownBlockProps,
  KeyValueListProps,
  KeyValuePair,
  ActionBarProps,
  ActionBarItem,
  LogViewProps,
  LogViewEntry,
  JsonTreeProps,
  SpinnerProps,
  ErrorBoundaryProps,
} from "./components.js";
