import {
  Component,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { PLUGIN_LAUNCHER_BOUNDS } from "@paperclipai/shared";
import type {
  PluginLauncherBounds,
  PluginLauncherDeclaration,
  PluginLauncherPlacementZone,
  PluginUiSlotEntityType,
} from "@paperclipai/shared";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { useNavigate, useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  PluginBridgeContext,
  type PluginHostContext,
  type PluginModalBoundsRequest,
  type PluginRenderCloseEvent,
  type PluginRenderCloseHandler,
  type PluginRenderEnvironmentContext,
} from "./bridge";
import {
  ensurePluginContributionLoaded,
  resolveRegisteredPluginComponent,
  type RegisteredPluginComponent,
} from "./slots";

export type PluginLauncherContext = {
  companyId?: string | null;
  companyPrefix?: string | null;
  projectId?: string | null;
  projectRef?: string | null;
  entityId?: string | null;
  entityType?: PluginUiSlotEntityType | null;
};

export type ResolvedPluginLauncher = PluginLauncherDeclaration & {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  pluginVersion: string;
  uiEntryFile: string;
};

type UsePluginLaunchersFilters = {
  placementZones: PluginLauncherPlacementZone[];
  entityType?: PluginUiSlotEntityType | null;
  companyId?: string | null;
  enabled?: boolean;
};

type UsePluginLaunchersResult = {
  launchers: ResolvedPluginLauncher[];
  contributionsByPluginId: Map<string, PluginUiContribution>;
  isLoading: boolean;
  errorMessage: string | null;
};

type PluginLauncherRuntimeContextValue = {
  /**
   * Open a launcher using already-discovered contribution metadata.
   *
   * The runtime accepts the normalized `PluginUiContribution` so callers can
   * reuse the `/api/plugins/ui-contributions` payload they already fetched
   * instead of issuing another request for each launcher activation.
   */
  activateLauncher(
    launcher: ResolvedPluginLauncher,
    hostContext: PluginLauncherContext,
    contribution: PluginUiContribution,
    sourceEl?: HTMLElement | null,
  ): Promise<void>;
};

type LauncherInstance = {
  key: string;
  launcher: ResolvedPluginLauncher;
  hostContext: PluginLauncherContext;
  contribution: PluginUiContribution;
  component: RegisteredPluginComponent | null;
  sourceElement: HTMLElement | null;
  sourceRect: DOMRect | null;
  bounds: PluginLauncherBounds | null;
  beforeCloseHandlers: Set<PluginRenderCloseHandler>;
  closeHandlers: Set<PluginRenderCloseHandler>;
};

const entityScopedZones = new Set<PluginLauncherPlacementZone>([
  "detailTab",
  "taskDetailView",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "projectSidebarItem",
  "toolbarButton",
]);
const focusableElementSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const launcherOverlayBaseZIndex = 1000;
const supportedLauncherBounds = new Set<PluginLauncherBounds>(
  PLUGIN_LAUNCHER_BOUNDS,
);

const PluginLauncherRuntimeContext = createContext<PluginLauncherRuntimeContextValue | null>(null);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

function buildLauncherHostContext(
  context: PluginLauncherContext,
  renderEnvironment: PluginRenderEnvironmentContext | null,
  userId: string | null,
): PluginHostContext {
  return {
    companyId: context.companyId ?? null,
    companyPrefix: context.companyPrefix ?? null,
    projectId: context.projectId ?? (context.entityType === "project" ? context.entityId ?? null : null),
    entityId: context.entityId ?? null,
    entityType: context.entityType ?? null,
    userId,
    renderEnvironment,
  };
}

function focusFirstElement(container: HTMLElement | null): void {
  if (!container) return;
  const firstFocusable = container.querySelector<HTMLElement>(focusableElementSelector);
  if (firstFocusable) {
    firstFocusable.focus();
    return;
  }
  container.focus();
}

function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(focusableElementSelector),
  ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function launcherTriggerClassName(placementZone: PluginLauncherPlacementZone): string {
  switch (placementZone) {
    case "projectSidebarItem":
      return "justify-start h-auto px-3 py-1 text-[12px] font-normal text-muted-foreground hover:text-foreground";
    case "contextMenuItem":
    case "commentContextMenuItem":
      return "justify-start h-7 w-full px-2 text-xs font-normal";
    case "sidebar":
    case "sidebarPanel":
      return "justify-start h-8 w-full";
    case "toolbarButton":
    case "globalToolbarButton":
      return "h-8";
    default:
      return "h-8";
  }
}

function launcherShellBoundsStyle(bounds: PluginLauncherBounds | null): CSSProperties {
  switch (bounds) {
    case "compact":
      return { width: "min(28rem, calc(100vw - 2rem))" };
    case "wide":
      return { width: "min(64rem, calc(100vw - 2rem))" };
    case "full":
      return { width: "calc(100vw - 2rem)", height: "calc(100vh - 2rem)" };
    case "inline":
      return { width: "min(24rem, calc(100vw - 2rem))" };
    case "default":
    default:
      return { width: "min(40rem, calc(100vw - 2rem))" };
  }
}

function launcherPopoverStyle(instance: LauncherInstance): CSSProperties {
  const rect = instance.sourceRect;
  const baseWidth = launcherShellBoundsStyle(instance.bounds).width ?? "min(24rem, calc(100vw - 2rem))";
  if (!rect) {
    return {
      width: baseWidth,
      maxHeight: "min(70vh, 36rem)",
      top: "4rem",
      left: "50%",
      transform: "translateX(-50%)",
    };
  }

  const top = Math.min(rect.bottom + 8, window.innerHeight - 32);
  const left = Math.min(
    Math.max(rect.left, 16),
    Math.max(16, window.innerWidth - 360),
  );

  return {
    width: baseWidth,
    maxHeight: "min(70vh, 36rem)",
    top,
    left,
  };
}

function isPluginLauncherBounds(value: unknown): value is PluginLauncherBounds {
  return typeof value === "string" && supportedLauncherBounds.has(value as PluginLauncherBounds);
}

/**
 * Discover launchers for the requested host placement zones from the normalized
 * `/api/plugins/ui-contributions` response.
 *
 * This is the shared discovery path for toolbar, sidebar, detail-view, and
 * context-menu launchers. The hook applies host-side entity filtering and
 * returns both the sorted launcher list and a contribution map so activation
 * can stay on cached metadata.
 */
export function usePluginLaunchers(
  filters: UsePluginLaunchersFilters,
): UsePluginLaunchersResult {
  const queryEnabled = filters.enabled ?? true;
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: queryEnabled,
  });

  const placementZonesKey = useMemo(
    () => [...filters.placementZones].sort().join("|"),
    [filters.placementZones],
  );

  const contributionsByPluginId = useMemo(() => {
    const byPluginId = new Map<string, PluginUiContribution>();
    for (const contribution of data ?? []) {
      byPluginId.set(contribution.pluginId, contribution);
    }
    return byPluginId;
  }, [data]);

  const launchers = useMemo(() => {
    const placementZones = new Set(
      placementZonesKey.split("|").filter(Boolean) as PluginLauncherPlacementZone[],
    );
    const rows: ResolvedPluginLauncher[] = [];
    for (const contribution of data ?? []) {
      for (const launcher of contribution.launchers) {
        if (!placementZones.has(launcher.placementZone)) continue;
        if (entityScopedZones.has(launcher.placementZone)) {
          if (!filters.entityType) continue;
          if (!launcher.entityTypes?.includes(filters.entityType)) continue;
        }
        rows.push({
          ...launcher,
          pluginId: contribution.pluginId,
          pluginKey: contribution.pluginKey,
          pluginDisplayName: contribution.displayName,
          pluginVersion: contribution.version,
          uiEntryFile: contribution.uiEntryFile,
        });
      }
    }

    rows.sort((a, b) => {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      const pluginCmp = a.pluginDisplayName.localeCompare(b.pluginDisplayName);
      if (pluginCmp !== 0) return pluginCmp;
      return a.displayName.localeCompare(b.displayName);
    });

    return rows;
  }, [data, filters.entityType, placementZonesKey]);

  return {
    launchers,
    contributionsByPluginId,
    isLoading: queryEnabled && isLoading,
    errorMessage: error ? getErrorMessage(error) : null,
  };
}

async function resolveLauncherComponent(
  contribution: PluginUiContribution,
  launcher: ResolvedPluginLauncher,
): Promise<RegisteredPluginComponent | null> {
  const exportName = launcher.action.target;
  const existing = resolveRegisteredPluginComponent(launcher.pluginKey, exportName);
  if (existing) return existing;
  await ensurePluginContributionLoaded(contribution);
  return resolveRegisteredPluginComponent(launcher.pluginKey, exportName);
}

/**
 * Scope bridge calls to the currently rendered launcher host context.
 *
 * Hooks such as `useHostContext()`, `usePluginData()`, and `usePluginAction()`
 * consume this ambient context so the bridge can forward company/entity scope
 * and render-environment metadata to the plugin worker.
 */
function PluginLauncherBridgeScope({
  pluginId,
  hostContext,
  children,
}: {
  pluginId: string;
  hostContext: PluginHostContext;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ pluginId, hostContext }), [pluginId, hostContext]);

  return (
    <PluginBridgeContext.Provider value={value}>
      {children}
    </PluginBridgeContext.Provider>
  );
}

type LauncherErrorBoundaryProps = {
  launcher: ResolvedPluginLauncher;
  children: ReactNode;
};

type LauncherErrorBoundaryState = {
  hasError: boolean;
};

class LauncherErrorBoundary extends Component<LauncherErrorBoundaryProps, LauncherErrorBoundaryState> {
  override state: LauncherErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LauncherErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Plugin launcher render failed", {
      pluginKey: this.props.launcher.pluginKey,
      launcherId: this.props.launcher.id,
      error,
      info: info.componentStack,
    });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {this.props.launcher.pluginDisplayName}: failed to render
        </div>
      );
    }
    return this.props.children;
  }
}

function LauncherRenderContent({
  instance,
  renderEnvironment,
}: {
  instance: LauncherInstance;
  renderEnvironment: PluginRenderEnvironmentContext;
}) {
  const component = instance.component;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const hostContext = useMemo(
    () => buildLauncherHostContext(instance.hostContext, renderEnvironment, userId),
    [instance.hostContext, renderEnvironment, userId],
  );

  if (!component) {
    if (renderEnvironment.environment === "iframe") {
      return (
        <iframe
          src={`/_plugins/${encodeURIComponent(instance.launcher.pluginId)}/ui/${instance.launcher.action.target}`}
          title={`${instance.launcher.pluginDisplayName} ${instance.launcher.displayName}`}
          className="h-full min-h-[24rem] w-full rounded-md border border-border bg-background"
        />
      );
    }

    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {instance.launcher.pluginDisplayName}: could not resolve launcher target "{instance.launcher.action.target}".
      </div>
    );
  }

  if (component.kind === "web-component") {
    return createElement(component.tagName, {
      className: "block w-full",
      pluginLauncher: instance.launcher,
      pluginContext: hostContext,
    });
  }

  const node = createElement(component.component as never, {
    launcher: instance.launcher,
    context: hostContext,
  } as never);

  return (
    <LauncherErrorBoundary launcher={instance.launcher}>
      <PluginLauncherBridgeScope pluginId={instance.launcher.pluginId} hostContext={hostContext}>
        {node}
      </PluginLauncherBridgeScope>
    </LauncherErrorBoundary>
  );
}

function LauncherModalShell({
  instance,
  stackIndex,
  isTopmost,
  requestBounds,
  closeLauncher,
}: {
  instance: LauncherInstance;
  stackIndex: number;
  isTopmost: boolean;
  requestBounds: (key: string, request: PluginModalBoundsRequest) => Promise<void>;
  closeLauncher: (key: string, event: PluginRenderCloseEvent) => Promise<void>;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!isTopmost) return;
    const frame = requestAnimationFrame(() => {
      focusFirstElement(contentRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [isTopmost]);

  useEffect(() => {
    if (!isTopmost) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!contentRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void closeLauncher(instance.key, { reason: "escapeKey", nativeEvent: event });
        return;
      }
      trapFocus(contentRef.current, event);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeLauncher, instance.key, isTopmost]);

  const renderEnvironment = useMemo<PluginRenderEnvironmentContext>(() => ({
    environment: instance.launcher.render?.environment ?? "hostOverlay",
    launcherId: instance.launcher.id,
    bounds: instance.bounds,
    requestModalBounds: (request) => requestBounds(instance.key, request),
    closeLifecycle: {
      onBeforeClose: (handler) => {
        instance.beforeCloseHandlers.add(handler);
        return () => instance.beforeCloseHandlers.delete(handler);
      },
      onClose: (handler) => {
        instance.closeHandlers.add(handler);
        return () => instance.closeHandlers.delete(handler);
      },
    },
  }), [instance, requestBounds]);

  const baseZ = launcherOverlayBaseZIndex + stackIndex * 20;
  // Keep each launcher in a deterministic z-index band so every stacked modal,
  // drawer, or popover retains its own backdrop/panel pairing.
  const shellType = instance.launcher.action.type;
  const containerStyle = shellType === "openPopover"
    ? launcherPopoverStyle(instance)
    : launcherShellBoundsStyle(instance.bounds);

  const panelClassName = shellType === "openDrawer"
    ? "fixed right-0 top-0 h-full max-w-[min(44rem,100vw)] overflow-hidden border-l border-border bg-background shadow-2xl"
    : shellType === "openPopover"
      ? "fixed overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      : "fixed left-1/2 top-1/2 max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-background shadow-2xl";

  return (
    <>
      <div
        className="fixed inset-0 bg-black/45"
        style={{ zIndex: baseZ }}
        aria-hidden="true"
        onMouseDown={(event) => {
          if (!isTopmost) return;
          if (event.target !== event.currentTarget) return;
          void closeLauncher(instance.key, { reason: "backdrop", nativeEvent: event });
        }}
      />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={panelClassName}
        style={{
          zIndex: baseZ + 1,
          ...(shellType === "openDrawer"
            ? { width: containerStyle.width ?? "min(44rem, 100vw)" }
            : containerStyle),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold">
              {instance.launcher.displayName}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {instance.launcher.pluginDisplayName}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => void closeLauncher(instance.key, { reason: "programmatic" })}
          >
            Close
          </Button>
        </div>
        <div
          className={cn(
            "overflow-auto p-4",
            shellType === "openDrawer" ? "h-[calc(100%-3.5rem)]" : "max-h-[calc(100vh-7rem)]",
          )}
        >
          <LauncherRenderContent instance={instance} renderEnvironment={renderEnvironment} />
        </div>
      </div>
    </>
  );
}

export function PluginLauncherProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<LauncherInstance[]>([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const location = useLocation();
  const navigate = useNavigate();

  const closeLauncher = useCallback(
    async (key: string, event: PluginRenderCloseEvent) => {
      const instance = stackRef.current.find((entry) => entry.key === key);
      if (!instance) return;

      for (const handler of [...instance.beforeCloseHandlers]) {
        await handler(event);
      }

      setStack((current) => current.filter((entry) => entry.key !== key));

      queueMicrotask(() => {
        for (const handler of [...instance.closeHandlers]) {
          void handler(event);
        }
        if (instance.sourceElement && document.contains(instance.sourceElement)) {
          instance.sourceElement.focus();
        }
      });
    },
    [],
  );

  useEffect(() => {
    if (stack.length === 0) return;
    void Promise.all(
      stack.map((entry) => closeLauncher(entry.key, { reason: "hostNavigation" })),
    );
    // Only react to navigation changes, not stack churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const requestBounds = useCallback(
    async (key: string, request: PluginModalBoundsRequest) => {
      // Bounds changes are host-validated. Unsupported presets are ignored so
      // plugin UI cannot push the shell into an undefined layout state.
      if (!isPluginLauncherBounds(request.bounds)) {
        return;
      }
      setStack((current) =>
        current.map((entry) =>
          entry.key === key
            ? { ...entry, bounds: request.bounds }
            : entry,
        ),
      );
    },
    [],
  );

  const activateLauncher = useCallback(
    async (
      launcher: ResolvedPluginLauncher,
      hostContext: PluginLauncherContext,
      contribution: PluginUiContribution,
      sourceEl?: HTMLElement | null,
    ) => {
      switch (launcher.action.type) {
        case "navigate":
          navigate(launcher.action.target);
          return;
        case "deepLink":
          if (/^https?:\/\//.test(launcher.action.target)) {
            window.open(launcher.action.target, "_blank", "noopener,noreferrer");
          } else {
            navigate(launcher.action.target);
          }
          return;
        case "performAction":
          await pluginsApi.bridgePerformAction(
            launcher.pluginId,
            launcher.action.target,
            launcher.action.params,
            hostContext.companyId ?? null,
          );
          return;
        case "openModal":
        case "openDrawer":
        case "openPopover": {
          const component = await resolveLauncherComponent(contribution, launcher);
          const sourceRect = sourceEl?.getBoundingClientRect() ?? null;
          const nextEntry: LauncherInstance = {
            key: `${launcher.pluginId}:${launcher.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            launcher,
            hostContext,
            contribution,
            component,
            sourceElement: sourceEl ?? null,
            sourceRect,
            bounds: launcher.render?.bounds ?? "default",
            beforeCloseHandlers: new Set(),
            closeHandlers: new Set(),
          };
          setStack((current) => [...current, nextEntry]);
          return;
        }
      }
    },
    [navigate],
  );

  const value = useMemo<PluginLauncherRuntimeContextValue>(
    () => ({ activateLauncher }),
    [activateLauncher],
  );

  return (
    <PluginLauncherRuntimeContext.Provider value={value}>
      {children}
      {stack.map((instance, index) => (
        <LauncherModalShell
          key={instance.key}
          instance={instance}
          stackIndex={index}
          isTopmost={index === stack.length - 1}
          requestBounds={requestBounds}
          closeLauncher={closeLauncher}
        />
      ))}
    </PluginLauncherRuntimeContext.Provider>
  );
}

export function usePluginLauncherRuntime(): PluginLauncherRuntimeContextValue {
  const value = useContext(PluginLauncherRuntimeContext);
  if (!value) {
    throw new Error("usePluginLauncherRuntime must be used within PluginLauncherProvider");
  }
  return value;
}

function DefaultLauncherTrigger({
  launcher,
  placementZone,
  onClick,
}: {
  launcher: ResolvedPluginLauncher;
  placementZone: PluginLauncherPlacementZone;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Button
      type="button"
      variant={placementZone === "toolbarButton" || placementZone === "globalToolbarButton" ? "outline" : "ghost"}
      size="sm"
      className={launcherTriggerClassName(placementZone)}
      onClick={onClick}
    >
      {launcher.displayName}
    </Button>
  );
}

type PluginLauncherOutletProps = {
  placementZones: PluginLauncherPlacementZone[];
  context: PluginLauncherContext;
  entityType?: PluginUiSlotEntityType | null;
  className?: string;
  itemClassName?: string;
  errorClassName?: string;
};

export function PluginLauncherOutlet({
  placementZones,
  context,
  entityType,
  className,
  itemClassName,
  errorClassName,
}: PluginLauncherOutletProps) {
  const { activateLauncher } = usePluginLauncherRuntime();
  const { launchers, contributionsByPluginId, errorMessage } = usePluginLaunchers({
    placementZones,
    entityType,
    companyId: context.companyId,
    enabled: !!context.companyId,
  });

  if (errorMessage) {
    return (
      <div className={cn("rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive", errorClassName)}>
        Plugin launchers unavailable: {errorMessage}
      </div>
    );
  }

  if (launchers.length === 0) return null;

  return (
    <div className={className}>
      {launchers.map((launcher) => (
        <div key={`${launcher.pluginKey}:${launcher.id}`} className={itemClassName}>
          <DefaultLauncherTrigger
            launcher={launcher}
            placementZone={launcher.placementZone}
            onClick={(event) => {
              const contribution = contributionsByPluginId.get(launcher.pluginId);
              if (!contribution) return;
              void activateLauncher(launcher, context, contribution, event.currentTarget);
            }}
          />
        </div>
      ))}
    </div>
  );
}

type PluginLauncherButtonProps = {
  launcher: ResolvedPluginLauncher;
  context: PluginLauncherContext;
  contribution: PluginUiContribution;
  className?: string;
  onActivated?: () => void;
};

export function PluginLauncherButton({
  launcher,
  context,
  contribution,
  className,
  onActivated,
}: PluginLauncherButtonProps) {
  const { activateLauncher } = usePluginLauncherRuntime();

  return (
    <div className={className}>
      <DefaultLauncherTrigger
        launcher={launcher}
        placementZone={launcher.placementZone}
        onClick={(event) => {
          event.preventDefault();
          onActivated?.();
          void activateLauncher(launcher, context, contribution, event.currentTarget);
        }}
      />
    </div>
  );
}
