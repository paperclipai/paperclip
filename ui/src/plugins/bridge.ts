/**
 * Plugin UI bridge runtime — concrete implementations of the bridge hooks.
 *
 * Plugin UI bundles import `usePluginData`, `usePluginAction`, and
 * `useHostContext` from `@paperclipai/plugin-sdk/ui`.  Those are type-only
 * declarations in the SDK package. The host provides the real implementations
 * by injecting this bridge runtime into the plugin's module scope.
 *
 * The bridge runtime communicates with plugin workers via HTTP REST endpoints:
 * - `POST /api/plugins/:pluginId/data/:key`     — proxies `getData` RPC
 * - `POST /api/plugins/:pluginId/actions/:key`   — proxies `performAction` RPC
 *
 * ## How it works
 *
 * 1. Before loading a plugin's UI module, the host creates a scoped bridge via
 *    `createPluginBridge(pluginId)`.
 * 2. The bridge's hook implementations are registered in a global bridge
 *    registry keyed by `pluginId`.
 * 3. The "ambient" hooks (`usePluginData`, `usePluginAction`, `useHostContext`)
 *    look up the current plugin context from a React context provider and
 *    delegate to the appropriate bridge instance.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PluginBridgeErrorCode,
  PluginLauncherBounds,
  PluginLauncherRenderContextSnapshot,
  PluginLauncherRenderEnvironment,
} from "@paperclipai/shared";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";

// ---------------------------------------------------------------------------
// Bridge error type (mirrors the SDK's PluginBridgeError)
// ---------------------------------------------------------------------------

/**
 * Structured error from the bridge, matching the SDK's `PluginBridgeError`.
 */
export interface PluginBridgeError {
  code: PluginBridgeErrorCode;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Bridge data result type (mirrors the SDK's PluginDataResult)
// ---------------------------------------------------------------------------

export interface PluginDataResult<T = unknown> {
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
  refresh(): void;
}

// ---------------------------------------------------------------------------
// Host context type (mirrors the SDK's PluginHostContext)
// ---------------------------------------------------------------------------

export interface PluginHostContext {
  companyId: string | null;
  companyPrefix: string | null;
  projectId: string | null;
  entityId: string | null;
  entityType: string | null;
  userId: string | null;
  renderEnvironment?: PluginRenderEnvironmentContext | null;
}

export interface PluginModalBoundsRequest {
  bounds: PluginLauncherBounds;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface PluginRenderCloseEvent {
  reason:
    | "escapeKey"
    | "backdrop"
    | "hostNavigation"
    | "programmatic"
    | "submit"
    | "unknown";
  nativeEvent?: unknown;
}

export type PluginRenderCloseHandler = (
  event: PluginRenderCloseEvent,
) => void | Promise<void>;

export interface PluginRenderCloseLifecycle {
  onBeforeClose?(handler: PluginRenderCloseHandler): () => void;
  onClose?(handler: PluginRenderCloseHandler): () => void;
}

export interface PluginRenderEnvironmentContext {
  environment: PluginLauncherRenderEnvironment | null;
  launcherId: string | null;
  bounds: PluginLauncherBounds | null;
  requestModalBounds?(request: PluginModalBoundsRequest): Promise<void>;
  closeLifecycle?: PluginRenderCloseLifecycle | null;
}

// ---------------------------------------------------------------------------
// Bridge context — stores the active pluginId for hook resolution
// ---------------------------------------------------------------------------

/**
 * Thread-local (module-level) context for the currently rendering plugin.
 *
 * The slot mount sets this before rendering a plugin component and clears it
 * after. The hooks read it to know which plugin's bridge to call.
 *
 * This is simpler than a React context because plugin modules are externalized
 * and can't access the host's React context tree directly.
 */
let activePluginId: string | null = null;
let activeHostContext: PluginHostContext = {
  companyId: null,
  companyPrefix: null,
  projectId: null,
  entityId: null,
  entityType: null,
  userId: null,
  renderEnvironment: null,
};

/**
 * Set the active plugin context before rendering a plugin component.
 *
 * This must be called synchronously before the plugin component's render
 * function executes, and cleared afterward.
 *
 * @param pluginId - The UUID of the plugin whose component is about to render
 * @param hostContext - The current host context (company, project, entity, user)
 */
export function setActiveBridgeContext(
  pluginId: string,
  hostContext: PluginHostContext,
): void {
  activePluginId = pluginId;
  activeHostContext = hostContext;
}

/**
 * Clear the active plugin context after rendering completes.
 */
export function clearActiveBridgeContext(): void {
  activePluginId = null;
  activeHostContext = {
    companyId: null,
    companyPrefix: null,
    projectId: null,
    entityId: null,
    entityType: null,
    userId: null,
    renderEnvironment: null,
  };
}

// ---------------------------------------------------------------------------
// Error extraction helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a structured PluginBridgeError from an API error.
 *
 * The bridge proxy endpoints return error bodies shaped as
 * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`.
 * This helper extracts that structure from the ApiError thrown by the client.
 */
function extractBridgeError(err: unknown): PluginBridgeError {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as Record<string, unknown>;
    if (typeof body.code === "string" && typeof body.message === "string") {
      return {
        code: body.code as PluginBridgeErrorCode,
        message: body.message,
        details: body.details,
      };
    }
    // Fallback: the server returned a plain { error: string } body
    if (typeof body.error === "string") {
      return {
        code: "UNKNOWN",
        message: body.error,
      };
    }
  }

  return {
    code: "UNKNOWN",
    message: err instanceof Error ? err.message : String(err),
  };
}

// ---------------------------------------------------------------------------
// usePluginData — concrete implementation
// ---------------------------------------------------------------------------

/**
 * Stable serialization of params for use as a dependency key.
 * Returns a string that changes only when the params object content changes.
 */
function serializeParams(params?: Record<string, unknown>): string {
  if (!params) return "";
  try {
    return JSON.stringify(params, Object.keys(params).sort());
  } catch {
    return "";
  }
}

function serializeRenderEnvironment(
  renderEnvironment?: PluginRenderEnvironmentContext | null,
): PluginLauncherRenderContextSnapshot | null {
  if (!renderEnvironment) return null;
  return {
    environment: renderEnvironment.environment,
    launcherId: renderEnvironment.launcherId,
    bounds: renderEnvironment.bounds,
  };
}

type CapturedBridgeScope = {
  pluginId: string | null;
  companyId: string | null;
  renderEnvironment: PluginLauncherRenderContextSnapshot | null;
};

function captureBridgeScope(
  scopeRef: { current: CapturedBridgeScope },
): CapturedBridgeScope {
  if (!scopeRef.current.pluginId && activePluginId) {
    scopeRef.current.pluginId = activePluginId;
  }

  if (activePluginId && activePluginId === scopeRef.current.pluginId) {
    scopeRef.current.companyId = activeHostContext.companyId;
    scopeRef.current.renderEnvironment = serializeRenderEnvironment(activeHostContext.renderEnvironment);
  }

  return scopeRef.current;
}

function serializeRenderEnvironmentSnapshot(
  snapshot: PluginLauncherRenderContextSnapshot | null,
): string {
  return snapshot ? JSON.stringify(snapshot) : "";
}

/**
 * Concrete implementation of `usePluginData<T>(key, params)`.
 *
 * Makes an HTTP POST to `/api/plugins/:pluginId/data/:key` and returns
 * a reactive `PluginDataResult<T>` matching the SDK type contract.
 *
 * Re-fetches automatically when `key` or `params` change. Provides a
 * `refresh()` function for manual re-fetch.
 */
export function usePluginData<T = unknown>(
  key: string,
  params?: Record<string, unknown>,
): PluginDataResult<T> {
  const scopeRef = useRef<CapturedBridgeScope>({
    pluginId: activePluginId,
    companyId: activeHostContext.companyId,
    renderEnvironment: serializeRenderEnvironment(activeHostContext.renderEnvironment),
  });
  const scope = captureBridgeScope(scopeRef);
  const pluginId = scope.pluginId;
  const companyId = scope.companyId;
  const renderEnvironmentSnapshot = scope.renderEnvironment;
  const renderEnvironmentKey = serializeRenderEnvironmentSnapshot(renderEnvironmentSnapshot);

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PluginBridgeError | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Stable serialization for params change detection
  const paramsKey = serializeParams(params);

  useEffect(() => {
    if (!pluginId) {
      setError({
        code: "UNKNOWN",
        message: "usePluginData called outside of a plugin component context",
      });
      setLoading(false);
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const maxRetryCount = 2;
    const retryableCodes: PluginBridgeErrorCode[] = ["WORKER_UNAVAILABLE", "TIMEOUT"];
    setLoading(true);
    const request = () => {
      pluginsApi
        .bridgeGetData(
          pluginId,
          key,
          params,
          companyId,
          renderEnvironmentSnapshot,
        )
        .then((response) => {
          if (!cancelled) {
            setData(response.data as T);
            setError(null);
            setLoading(false);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;

          const bridgeError = extractBridgeError(err);
          if (retryableCodes.includes(bridgeError.code) && retryCount < maxRetryCount) {
            retryCount += 1;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!cancelled) request();
            }, 150 * retryCount);
            return;
          }

          setError(bridgeError);
          setData(null);
          setLoading(false);
        });
    };

    request();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, key, paramsKey, refreshCounter, companyId, renderEnvironmentKey]);

  const refresh = useCallback(() => {
    setRefreshCounter((c) => c + 1);
  }, []);

  return { data, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// usePluginAction — concrete implementation
// ---------------------------------------------------------------------------

/**
 * Action function type matching the SDK's `PluginActionFn`.
 */
export type PluginActionFn = (params?: Record<string, unknown>) => Promise<unknown>;

/**
 * Concrete implementation of `usePluginAction(key)`.
 *
 * Returns a stable async function that, when called, sends a POST to
 * `/api/plugins/:pluginId/actions/:key` and returns the worker result.
 *
 * On failure, the function throws a `PluginBridgeError`.
 */
export function usePluginAction(key: string): PluginActionFn {
  const scopeRef = useRef<CapturedBridgeScope>({
    pluginId: activePluginId,
    companyId: activeHostContext.companyId,
    renderEnvironment: serializeRenderEnvironment(activeHostContext.renderEnvironment),
  });
  captureBridgeScope(scopeRef);

  return useCallback(
    async (params?: Record<string, unknown>): Promise<unknown> => {
      const {
        pluginId,
        companyId,
        renderEnvironment,
      } = scopeRef.current;
      if (!pluginId) {
        const err: PluginBridgeError = {
          code: "UNKNOWN",
          message: "usePluginAction called outside of a plugin component context",
        };
        throw err;
      }

      try {
        const response = await pluginsApi.bridgePerformAction(
          pluginId,
          key,
          params,
          companyId,
          renderEnvironment,
        );
        return response.data;
      } catch (err) {
        throw extractBridgeError(err);
      }
    },
    [key],
  );
}

// ---------------------------------------------------------------------------
// useHostContext — concrete implementation
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `useHostContext()`.
 *
 * Returns the current host context (company, project, entity, user) that
 * was set by the slot mount via `setActiveBridgeContext()`.
 */
export function useHostContext(): PluginHostContext {
  const pluginIdRef = useRef(activePluginId);
  if (!pluginIdRef.current && activePluginId) {
    pluginIdRef.current = activePluginId;
  }

  const hostContextRef = useRef(activeHostContext);
  if (activePluginId && activePluginId === pluginIdRef.current) {
    hostContextRef.current = activeHostContext;
  }

  return hostContextRef.current;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset all bridge state. Only use in tests.
 * @internal
 */
export function _resetBridgeState(): void {
  activePluginId = null;
  activeHostContext = {
    companyId: null,
    companyPrefix: null,
    projectId: null,
    entityId: null,
    entityType: null,
    userId: null,
  };
}
