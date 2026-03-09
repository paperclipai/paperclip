/**
 * Paperclip plugin UI SDK — types for plugin frontend components.
 *
 * Plugin UI bundles import from `@paperclipai/plugin-sdk/ui`.  This subpath
 * provides the bridge hooks, component prop interfaces, and error types that
 * plugin React components use to communicate with the host.
 *
 * Plugin UI bundles are loaded as ES modules into designated extension slots.
 * All communication with the plugin worker goes through the host bridge — plugin
 * components must NOT access host internals or call host APIs directly.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

import type {
  PluginBridgeErrorCode,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
} from "@paperclipai/shared";
import type {
  PluginLauncherRenderContextSnapshot,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
} from "../protocol.js";

// Re-export PluginBridgeErrorCode for plugin UI authors
export type {
  PluginBridgeErrorCode,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
} from "@paperclipai/shared";
export type {
  PluginLauncherRenderContextSnapshot,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
} from "../protocol.js";

// ---------------------------------------------------------------------------
// Bridge error
// ---------------------------------------------------------------------------

/**
 * Structured error returned by the bridge when a UI → worker call fails.
 *
 * Plugin components receive this in `usePluginData()` as the `error` field
 * and may encounter it as a thrown value from `usePluginAction()`.
 *
 * Error codes:
 * - `WORKER_UNAVAILABLE` — plugin worker is not running
 * - `CAPABILITY_DENIED` — plugin lacks the required capability
 * - `WORKER_ERROR` — worker returned an error from its handler
 * - `TIMEOUT` — worker did not respond within the configured timeout
 * - `UNKNOWN` — unexpected bridge-level failure
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export interface PluginBridgeError {
  /** Machine-readable error code. */
  code: PluginBridgeErrorCode;
  /** Human-readable error message. */
  message: string;
  /**
   * Original error details from the worker, if available.
   * Only present when `code === "WORKER_ERROR"`.
   */
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Host context available to all plugin components
// ---------------------------------------------------------------------------

/**
 * Read-only host context passed to every plugin component via `useHostContext()`.
 *
 * Plugin components use this to know which company, project, or entity is
 * currently active so they can scope their data requests accordingly.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export interface PluginHostContext {
  /** UUID of the currently active company, if any. */
  companyId: string | null;
  /** URL prefix for the current company (e.g. `"my-company"`). */
  companyPrefix: string | null;
  /** UUID of the currently active project, if any. */
  projectId: string | null;
  /** UUID of the current entity (for detail tab contexts), if any. */
  entityId: string | null;
  /** Type of the current entity (e.g. `"issue"`, `"agent"`). */
  entityType: string | null;
  /** UUID of the current authenticated user. */
  userId: string | null;
  /** Runtime metadata for the host container currently rendering this plugin UI. */
  renderEnvironment?: PluginRenderEnvironmentContext | null;
}

/**
 * Async-capable callback invoked during a host-managed close lifecycle.
 */
export type PluginRenderCloseHandler = (
  event: PluginRenderCloseEvent,
) => void | Promise<void>;

/**
 * Close lifecycle hooks available when the plugin UI is rendered inside a
 * host-managed launcher environment.
 */
export interface PluginRenderCloseLifecycle {
  /** Register a callback before the host closes the current environment. */
  onBeforeClose?(handler: PluginRenderCloseHandler): () => void;
  /** Register a callback after the host closes the current environment. */
  onClose?(handler: PluginRenderCloseHandler): () => void;
}

/**
 * Runtime information about the host container currently rendering a plugin UI.
 */
export interface PluginRenderEnvironmentContext
  extends PluginLauncherRenderContextSnapshot {
  /** Optional host callback for requesting new bounds while a modal is open. */
  requestModalBounds?(request: PluginModalBoundsRequest): Promise<void>;
  /** Optional close lifecycle callbacks for host-managed overlays. */
  closeLifecycle?: PluginRenderCloseLifecycle | null;
}

// ---------------------------------------------------------------------------
// Slot component prop interfaces
// ---------------------------------------------------------------------------

/**
 * Props passed to a plugin page component.
 *
 * A page is a full-page extension at `/plugins/:pluginId` or `/:company/plugins/:pluginId`.
 *
 * @see PLUGIN_SPEC.md §19.1 — Global Operator Routes
 * @see PLUGIN_SPEC.md §19.2 — Company-Context Routes
 */
export interface PluginPageProps {
  /** The current host context. */
  context: PluginHostContext;
}

/**
 * Props passed to a plugin dashboard widget component.
 *
 * A dashboard widget is rendered as a card or section on the main dashboard.
 *
 * @see PLUGIN_SPEC.md §19.4 — Dashboard Widgets
 */
export interface PluginWidgetProps {
  /** The current host context. */
  context: PluginHostContext;
}

/**
 * Props passed to a plugin detail tab component.
 *
 * A detail tab is rendered as an additional tab on a project, issue, agent,
 * goal, or run detail page.
 *
 * @see PLUGIN_SPEC.md §19.3 — Detail Tabs
 */
export interface PluginDetailTabProps {
  /** The current host context, always including `entityId` and `entityType`. */
  context: PluginHostContext & {
    entityId: string;
    entityType: string;
  };
}

/**
 * Props passed to a plugin sidebar component.
 *
 * A sidebar entry adds a link or section to the application sidebar.
 *
 * @see PLUGIN_SPEC.md §19.5 — Sidebar Entries
 */
export interface PluginSidebarProps {
  /** The current host context. */
  context: PluginHostContext;
}

/**
 * Props passed to a plugin project sidebar item component.
 *
 * A project sidebar item is rendered **once per project** under that project's
 * row in the sidebar Projects list. The host passes the current project's id
 * in `context.entityId` and `context.entityType` is `"project"`.
 *
 * Use this slot to add a link (e.g. "Files", "Linear Sync") that navigates to
 * the project detail with a plugin tab selected: `/projects/:projectRef?tab=plugin:key:slotId`.
 *
 * @see PLUGIN_SPEC.md §19.5.1 — Project sidebar items
 */
export interface PluginProjectSidebarItemProps {
  /** Host context plus entityId (project id) and entityType "project". */
  context: PluginHostContext & {
    entityId: string;
    entityType: "project";
  };
}

/**
 * Props passed to a plugin settings page component.
 *
 * Overrides the auto-generated JSON Schema form when the plugin declares
 * a `settingsPage` UI slot. The component is responsible for reading and
 * writing config through the bridge.
 *
 * @see PLUGIN_SPEC.md §19.8 — Plugin Settings UI
 */
export interface PluginSettingsPageProps {
  /** The current host context. */
  context: PluginHostContext;
}

// ---------------------------------------------------------------------------
// usePluginData hook return type
// ---------------------------------------------------------------------------

/**
 * Return value of `usePluginData(key, params)`.
 *
 * Mirrors a standard async data-fetching hook pattern:
 * exactly one of `data` or `error` is non-null at any time (unless `loading`).
 *
 * @template T The type of the data returned by the worker handler
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export interface PluginDataResult<T = unknown> {
  /** The data returned by the worker's `getData` handler. `null` while loading or on error. */
  data: T | null;
  /** `true` while the initial request or a refresh is in flight. */
  loading: boolean;
  /** Bridge error if the request failed. `null` on success or while loading. */
  error: PluginBridgeError | null;
  /**
   * Manually trigger a data refresh.
   * Useful for poll-based updates or post-action refreshes.
   */
  refresh(): void;
}

// ---------------------------------------------------------------------------
// usePluginAction hook return type
// ---------------------------------------------------------------------------

/**
 * Return value of `usePluginAction(key)`.
 *
 * Returns an async function that, when called, sends an action request
 * to the worker's `performAction` handler and returns the result.
 *
 * On failure, the async function throws a `PluginBridgeError`.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 *
 * @example
 * ```tsx
 * const resync = usePluginAction("resync");
 * <button onClick={() => resync({ companyId }).catch(err => console.error(err))}>
 *   Resync Now
 * </button>
 * ```
 */
export type PluginActionFn = (params?: Record<string, unknown>) => Promise<unknown>;
