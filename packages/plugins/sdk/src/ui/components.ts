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
