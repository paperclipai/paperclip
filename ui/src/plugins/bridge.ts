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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLocation as useRouterLocation, useNavigate as useRouterNavigate, type NavigateOptions } from "react-router-dom";
import type {
  PluginBridgeErrorCode,
  PluginLauncherBounds,
  PluginLauncherRenderContextSnapshot,
  PluginLauncherRenderEnvironment,
} from "@paperclipai/shared";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";
import { useToastActions, type ToastInput } from "@/context/ToastContext";
import { useSidebar } from "@/context/SidebarContext";
import { isGlobalPath, normalizeCompanyPrefix } from "@/lib/company-routes";

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

export type PluginToastInput = ToastInput;
export type PluginToastFn = (input: PluginToastInput) => string | null;

export interface HostNavigationOptions {
  replace?: boolean;
  state?: unknown;
}

export interface HostNavigationLinkOptions extends HostNavigationOptions {
  target?: string;
  rel?: string;
}

export interface HostNavigationLinkProps {
  href: string;
  target?: string;
  rel?: string;
  onClick(event: ReactMouseEvent<HTMLAnchorElement>): void;
}

export interface HostNavigation {
  resolveHref(to: string): string;
  navigate(to: string, options?: HostNavigationOptions): void;
  linkProps(to: string, options?: HostNavigationLinkOptions): HostNavigationLinkProps;
}

export interface HostLocation {
  pathname: string;
  search: string;
  hash: string;
  state?: unknown;
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
  parentEntityId?: string | null;
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
// Bridge context — React context for plugin identity and host scope
// ---------------------------------------------------------------------------

export type PluginBridgeContextValue = {
  pluginId: string;
  hostContext: PluginHostContext;
};

/**
 * React context that carries the active plugin identity and host scope.
 *
 * The slot/launcher mount wraps plugin components in a Provider so that
 * bridge hooks (`usePluginData`, `usePluginAction`, `useHostContext`) can
 * resolve the current plugin without ambient mutable globals.
 *
 * Because plugin bundles share the host's React instance (via the bridge
 * registry on `globalThis.__paperclipPluginBridge__`), context propagation
 * works correctly across the host/plugin boundary.
 */
export const PluginBridgeContext =
  createContext<PluginBridgeContextValue | null>(null);

function usePluginBridgeContext(): PluginBridgeContextValue {
  const ctx = useContext(PluginBridgeContext);
  if (!ctx) {
    throw new Error(
      "Plugin bridge hook called outside of a <PluginBridgeContext.Provider>. " +
        "Ensure the plugin component is rendered within a PluginBridgeScope.",
    );
  }
  return ctx;
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

function serializeRenderEnvironmentSnapshot(
  snapshot: PluginLauncherRenderContextSnapshot | null,
): string {
  return snapshot ? JSON.stringify(snapshot) : "";
}

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function sameOriginPathFromHref(href: string): string | null {
  if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith("//")) {
    return href;
  }
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function hasCompanyPrefix(pathname: string, companyPrefix: string): boolean {
  const [firstSegment] = pathname.split("/").filter(Boolean);
  return firstSegment?.toUpperCase() === normalizeCompanyPrefix(companyPrefix);
}

/**
 * Resolve a plugin-provided Paperclip path to the active company scope.
 *
 * This intentionally handles plugin page roots such as `/wiki`, which cannot
 * be listed in the host router's static board-route table ahead of time.
 */
export function resolveHostNavigationHref(
  to: string,
  companyPrefix: string | null | undefined,
): string {
  const sameOriginPath = sameOriginPathFromHref(to);
  if (sameOriginPath === null) return to;

  const { pathname, search, hash } = splitPath(sameOriginPath);
  if (!pathname.startsWith("/") || isGlobalPath(pathname) || !companyPrefix) {
    return sameOriginPath;
  }

  if (hasCompanyPrefix(pathname, companyPrefix)) {
    return sameOriginPath;
  }

  return `/${normalizeCompanyPrefix(companyPrefix)}${pathname}${search}${hash}`;
}

function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}

export function shouldHandleHostNavigationClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
  target?: string,
): boolean {
  if (!isPlainLeftClick(event)) return false;
  if (target && target !== "_self") return false;
  if (event.currentTarget.hasAttribute("download")) return false;
  return sameOriginPathFromHref(href) !== null;
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
  const { pluginId, hostContext } = usePluginBridgeContext();
  const companyId = hostContext.companyId;
  const renderEnvironmentSnapshot = serializeRenderEnvironment(hostContext.renderEnvironment);
  const renderEnvironmentKey = serializeRenderEnvironmentSnapshot(renderEnvironmentSnapshot);

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PluginBridgeError | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Stable serialization for params change detection
  const paramsKey = serializeParams(params);

  useEffect(() => {
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
  const bridgeContext = usePluginBridgeContext();
  const contextRef = useRef(bridgeContext);
  contextRef.current = bridgeContext;

  return useCallback(
    async (params?: Record<string, unknown>): Promise<unknown> => {
      const { pluginId, hostContext } = contextRef.current;
      const companyId = hostContext.companyId;
      const renderEnvironment = serializeRenderEnvironment(hostContext.renderEnvironment);

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
 * Returns the current host context (company, project, entity, user)
 * from the enclosing `PluginBridgeContext.Provider`.
 */
export function useHostContext(): PluginHostContext {
  const { hostContext } = usePluginBridgeContext();
  return hostContext;
}

// ---------------------------------------------------------------------------
// useHostNavigation — concrete implementation
// ---------------------------------------------------------------------------

export function useHostNavigation(): HostNavigation {
  const { hostContext } = usePluginBridgeContext();
  const routerNavigate = useRouterNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const companyPrefix = hostContext.companyPrefix;

  const resolveHref = useCallback(
    (to: string) => resolveHostNavigationHref(to, companyPrefix),
    [companyPrefix],
  );

  const navigate = useCallback(
    (to: string, options?: HostNavigationOptions) => {
      const href = resolveHref(to);
      const sameOriginPath = sameOriginPathFromHref(href);
      if (sameOriginPath === null) {
        window.location.assign(href);
        return;
      }
      routerNavigate(sameOriginPath, options as NavigateOptions | undefined);
      // Mirror host sidebar behavior: tapping a link inside the mobile drawer
      // dismisses the drawer so the user can see the destination page.
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, resolveHref, routerNavigate, setSidebarOpen],
  );

  const linkProps = useCallback(
    (to: string, options?: HostNavigationLinkOptions): HostNavigationLinkProps => {
      const href = resolveHref(to);
      return {
        href,
        target: options?.target,
        rel: options?.rel,
        onClick: (event) => {
          if (!shouldHandleHostNavigationClick(event, href, options?.target)) return;
          event.preventDefault();
          navigate(href, options);
        },
      };
    },
    [navigate, resolveHref],
  );

  return useMemo(
    () => ({
      resolveHref,
      navigate,
      linkProps,
    }),
    [linkProps, navigate, resolveHref],
  );
}

// ---------------------------------------------------------------------------
// useHostLocation — concrete implementation
// ---------------------------------------------------------------------------

export function useHostLocation(): HostLocation {
  const location = useRouterLocation();
  return useMemo(
    () => ({
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      state: location.state,
    }),
    [location.hash, location.pathname, location.search, location.state],
  );
}

// ---------------------------------------------------------------------------
// usePluginToast — concrete implementation
// ---------------------------------------------------------------------------

export function usePluginToast(): PluginToastFn {
  const { pushToast } = useToastActions();
  return useCallback(
    (input: PluginToastInput) => pushToast(input),
    [pushToast],
  );
}

// ---------------------------------------------------------------------------
// usePluginStream — concrete implementation
// ---------------------------------------------------------------------------

export interface PluginStreamResult<T = unknown> {
  events: T[];
  lastEvent: T | null;
  connecting: boolean;
  connected: boolean;
  error: Error | null;
  close(): void;
}

export function usePluginStream<T = unknown>(
  channel: string,
  options?: { companyId?: string },
): PluginStreamResult<T> {
  const { pluginId, hostContext } = usePluginBridgeContext();
  const effectiveCompanyId = options?.companyId ?? hostContext.companyId ?? undefined;
  const [events, setEvents] = useState<T[]>([]);
  const [lastEvent, setLastEvent] = useState<T | null>(null);
  const [connecting, setConnecting] = useState<boolean>(Boolean(effectiveCompanyId));
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setConnecting(false);
    setConnected(false);
  }, []);

  useEffect(() => {
    setEvents([]);
    setLastEvent(null);
    setError(null);

    if (!effectiveCompanyId) {
      close();
      return;
    }

    const params = new URLSearchParams({ companyId: effectiveCompanyId });
    const source = new EventSource(
      `/api/plugins/${encodeURIComponent(pluginId)}/bridge/stream/${encodeURIComponent(channel)}?${params.toString()}`,
      { withCredentials: true },
    );
    sourceRef.current = source;
    setConnecting(true);
    setConnected(false);

    source.onopen = () => {
      setConnecting(false);
      setConnected(true);
      setError(null);
    };

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as T;
        setEvents((current) => [...current, parsed]);
        setLastEvent(parsed);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
      }
    };

    source.addEventListener("close", () => {
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
      setConnecting(false);
      setConnected(false);
    });

    source.onerror = () => {
      setConnecting(false);
      setConnected(false);
      setError(new Error(`Failed to connect to plugin stream "${channel}"`));
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };

    return () => {
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };
  }, [channel, close, effectiveCompanyId, pluginId]);

  return { events, lastEvent, connecting, connected, error, close };
}
