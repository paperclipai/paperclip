import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BROWSER_USE_VIEWPORT_PRESETS,
  type BrowserUseViewportPreset,
  type BrowserUseViewportState,
  type BrowserUseSettings,
  type TaskBrowser,
} from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
import { TaskBrowserPanel } from "@/components/task-side-panel/TaskBrowserPanel";

export const browserFixture: TaskBrowser = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  issueId: "browser-story",
  status: "running",
  runStatus: "running",
  progress: null,
  costCents: 15,
  idleDeadline: null,
  expiresAt: null,
  error: null,
  createdAt: "2026-09-29T00:00:00Z",
};
export function browserState(
  status: TaskBrowser["status"],
  seconds = 600,
): TaskBrowser {
  return {
    ...browserFixture,
    status,
    runStatus: status === "running" ? "running" : "completed",
    idleDeadline:
      status === "idle"
        ? new Date(Date.now() + seconds * 1000).toISOString()
        : null,
  };
}
export function BrowserStoryProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
export function InteractiveBrowserStory({
  initial,
  accessError = false,
}: {
  initial?: TaskBrowser;
  accessError?: boolean;
}) {
  const [current, setCurrent] = useState(initial);
  useEffect(() => {
    const listener = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      setCurrent((value) =>
        value
          ? {
              ...value,
              status: action === "end" ? "closed" : "idle",
              runStatus: action === "keep_open" ? value.runStatus : "cancelled",
              idleDeadline: new Date(Date.now() + 600000).toISOString(),
            }
          : value,
      );
    };
    window.addEventListener("browser-fixture-control", listener);
    return () =>
      window.removeEventListener("browser-fixture-control", listener);
  }, []);
  return (
    <TaskBrowserPanel
      issueId="browser-story"
      browser={current}
      accessError={accessError}
    />
  );
}
export function mockBrowserUse(
  options: {
    disconnected?: boolean;
    controlError?: boolean;
    loading?: boolean;
    profilesError?: boolean;
    saveError?: boolean;
    emptyProfiles?: boolean;
    viewport?: BrowserUseViewportPreset;
    resizeError?: boolean;
    resizing?: boolean;
    controlledElsewhere?: boolean;
  } = {},
) {
  const original = { ...browserUseApi };
  let live = browserState("running");
  let viewerAttempts = 0;
  let viewport: BrowserUseViewportPreset = options.viewport ?? "fit";
  let dimensions: { width: number; height: number } | undefined;
  let owner: string | undefined = options.controlledElsewhere
    ? "another-viewer"
    : undefined;
  const state = (viewerId?: string): BrowserUseViewportState => ({
    preset: viewport,
    ...dimensions,
    controlledElsewhere: Boolean(owner && owner !== viewerId),
  });
  const sendViewport = (target: Window | null) =>
    target?.postMessage(
      {
        type: "browser-fixture-viewport",
        size:
          viewport === "fit"
            ? dimensions
            : (BROWSER_USE_VIEWPORT_PRESETS.find((p) => p.id === viewport) ??
              null),
      },
      window.location.origin,
    );
  const onViewerReady = (event: MessageEvent) => {
    if (
      event.origin === window.location.origin &&
      event.data?.type === "browser-fixture-ready"
    )
      sendViewport(event.source as Window);
  };
  window.addEventListener("message", onViewerReady);
  const settings = new Map<string, BrowserUseSettings>();
  browserUseApi.list = async () => [live];
  browserUseApi.presence = async () => ({ accepted: true });
  browserUseApi.viewer = async (_issue, _browser, _signal, viewerId) => {
    if (options.loading) return new Promise(() => {});
    if (options.disconnected && viewerAttempts++ === 0)
      throw new Error("Simulated disconnect");
    return {
      url: "/browser-viewer.html",
      viewport,
      viewportState: state(viewerId),
    };
  };
  browserUseApi.resize = async (_issue, _browser, request) => {
    if (options.resizing) return new Promise(() => {});
    if (options.resizeError) throw new Error("Simulated resize failure");
    if (
      request.preset === "fit" &&
      !request.takeControl &&
      (viewport !== "fit" || (owner && owner !== request.viewerId))
    )
      return state(request.viewerId);
    viewport = request.preset;
    dimensions =
      request.preset === "fit"
        ? { width: request.width, height: request.height }
        : undefined;
    owner = request.preset === "fit" ? request.viewerId : undefined;
    document
      .querySelectorAll<HTMLIFrameElement>(
        'iframe[title="Live Browser Use browser"]',
      )
      .forEach((frame) => sendViewport(frame.contentWindow));
    return state(request.viewerId);
  };
  browserUseApi.releaseViewport = async (_issue, _browser, viewerId) => {
    if (owner === viewerId) owner = undefined;
    return { accepted: true };
  };
  browserUseApi.control = async (_issue, _browser, action) => {
    if (options.controlError) throw new Error("Simulated control failure");
    live = { ...live, ...browserState(action === "end" ? "closed" : "idle") };
    window.dispatchEvent(
      new CustomEvent("browser-fixture-control", { detail: action }),
    );
    return { accepted: true };
  };
  browserUseApi.settings = async (_company, grant) => {
    if (options.loading) return new Promise(() => {});
    return settings.get(grant) ?? { allowedProfileIds: [], maxCostUsd: 1 };
  };
  browserUseApi.profiles = async () => {
    if (options.loading) return new Promise(() => {});
    if (options.profilesError) throw new Error("Simulated profile failure");
    return options.emptyProfiles
      ? []
      : [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Research workspace",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Support workspace",
          },
        ];
  };
  browserUseApi.saveSettings = async (_company, grant, value) => {
    if (options.saveError) throw new Error("Simulated save failure");
    settings.set(grant, value);
    return value;
  };
  return () => {
    window.removeEventListener("message", onViewerReady);
    Object.assign(browserUseApi, original);
  };
}
