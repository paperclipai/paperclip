import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type BrowserUseControl, type TaskBrowser } from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
import { QueryErrorState, QueryStaleHint } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Globe, LoaderCircle } from "lucide-react";
import { useBrowserViewport } from "@/hooks/useBrowserViewport";
import { useResilientFetch } from "@/hooks/useResilientFetch";
import { TaskBrowserFooter } from "./TaskBrowserFooter";

/** Revalidate the viewer credential this often, even while the panel is hidden. */
const VIEWER_REVALIDATION_MS = 15_000;

export function TaskBrowserPanel({
  issueId,
  browser,
  accessError = false,
  active = true,
  onOpenActiveBrowser,
}: {
  issueId: string;
  browser?: TaskBrowser;
  accessError?: boolean;
  active?: boolean;
  onOpenActiveBrowser?: () => void;
}) {
  const cache = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const automaticReconnects = useRef(0);
  const reconnect = () => {
    automaticReconnects.current = 0;
    setRefresh((n) => n + 1);
  };
  const [viewerLoad, setViewerLoad] = useState<
    "loading" | "loaded" | "timed-out"
  >("loading");
  const [now, setNow] = useState(Date.now());
  const frameRef = useRef<HTMLIFrameElement>(null);
  const viewable = Boolean(
    browser && ["running", "idle"].includes(browser.status) && !accessError,
  );
  const browserId = browser?.id;
  // The viewport hook needs the viewer URL and the viewer read needs the
  // viewport's version and viewer id; the ref breaks the cycle.
  const viewportRef = useRef<ReturnType<typeof useBrowserViewport> | null>(null);
  // The bearer viewer URL lives in this component's memory only, never in a
  // shared or persisted cache. It is revalidated even while hidden, so a
  // revoked credential (a real 403/404) promptly unmounts its iframe, while a
  // transient failure keeps the loaded view on screen.
  const viewer = useResilientFetch({
    key: ["task-browser-viewer", issueId, browserId ?? null, refresh],
    enabled: viewable && Boolean(browserId),
    refetchInterval: VIEWER_REVALIDATION_MS,
    keepDataOnError: false,
    fetcher: async (signal) => {
      const version = viewportRef.current?.version.current ?? 0;
      const result = await browserUseApi.viewer(
        issueId,
        browserId!,
        signal,
        viewportRef.current?.viewerId,
      );
      return { ...result, version };
    },
    onSuccess: (result) => {
      viewportRef.current?.receive(
        result.viewportState ?? { preset: result.viewport ?? "fit" },
        result.version,
      );
    },
  });
  const url =
    viewer.view.kind === "ready" || viewer.view.kind === "stale"
      ? viewer.data?.url ?? null
      : null;
  const viewerError = viewer.view.kind === "error" ? viewer.error : null;
  const viewport = useBrowserViewport({
    issueId,
    browserId,
    enabled: Boolean(viewable && url && viewerLoad === "loaded"),
    active,
    frameRef,
  });
  viewportRef.current = viewport;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setActionError(null);
  }, [issueId, browserId, viewable, refresh]);
  useEffect(() => {
    setViewerLoad("loading");
  }, [url, refresh]);
  useEffect(() => {
    automaticReconnects.current = 0;
  }, [browser?.id]);
  useEffect(() => {
    // A hidden iframe may not navigate until shown. Give the selected viewer
    // a full load window, then reconnect once before asking the user to act.
    if (!active || !url || viewerLoad !== "loading") return;
    const timer = setTimeout(() => {
      if (automaticReconnects.current === 0) {
        automaticReconnects.current += 1;
        setRefresh((n) => n + 1);
      } else {
        setViewerLoad("timed-out");
      }
    }, 15_000);
    return () => clearTimeout(timer);
  }, [active, url, refresh, viewerLoad]);
  const [presenceError, setPresenceError] = useState(false);
  useEffect(() => {
    if (!active || !viewable || !url || !browser || browser.status !== "idle")
      return;
    let disposed = false;
    let pending = false;
    const renew = async () => {
      const frame = frameRef.current;
      if (
        pending ||
        document.visibilityState === "hidden" ||
        !frame ||
        !frame.getClientRects().length ||
        (frame.checkVisibility &&
          !frame.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }))
      )
        return;
      pending = true;
      try {
        const result = await browserUseApi.presence(issueId, browser.id);
        if (!disposed && result.accepted) setPresenceError(false);
      } catch {
        if (!disposed) setPresenceError(true);
      } finally {
        pending = false;
      }
    };
    void renew();
    const timer = setInterval(() => void renew(), 30_000);
    document.addEventListener("visibilitychange", renew);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [active, viewable, url, browser?.id, browser?.status, issueId]);
  const action = useMutation({
    mutationFn: (value: BrowserUseControl) =>
      browserUseApi.control(issueId, browser!.id, value),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["task-browsers", issueId] });
    },
    onError: () => setActionError("The browser action failed. Try again."),
  });
  const message = accessError
    ? "You no longer have access to this browser."
    : (browser?.error ?? actionError);
  const heading = accessError
    ? "Browser access unavailable"
    : browser?.status === "starting"
      ? "Starting browser…"
      : browser?.status === "stopping"
        ? "Closing browser…"
        : browser?.status === "closed"
          ? "Browser closed"
          : browser?.status === "failed"
            ? "Browser could not start"
            : viewable
              ? "Connecting to browser…"
              : "No browser open";
  const waiting =
    !message &&
    (browser?.status === "starting" ||
      browser?.status === "stopping" ||
      viewable);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {viewable && viewerError ? (
        // A real failure (the credential was revoked, the browser is gone):
        // the iframe is already unmounted, so say so and offer a retry.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto p-6">
          <QueryErrorState
            error={viewerError}
            action="connect to the live browser view"
            onRetry={viewer.view.retry}
            retrying={viewer.view.isFetching}
            className="max-w-sm"
          />
        </div>
      ) : viewable && url ? (
        <div className="relative min-h-0 flex-1">
          <iframe
            ref={frameRef}
            key={refresh}
            title="Live Browser Use browser"
            src={url}
            onLoad={() => setViewerLoad("loaded")}
            referrerPolicy="no-referrer"
            allow="autoplay; clipboard-write"
            className="absolute inset-0 h-full w-full border-0"
          />
          {viewerLoad !== "loaded" && (
            <div
              role={viewerLoad === "timed-out" ? "alert" : "status"}
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center"
            >
              {viewerLoad === "loading" ? (
                <>
                  <LoaderCircle
                    className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  <p className="text-sm">Connecting to browser…</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">
                    The live view did not load
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Reconnect the view or open this task in another browser. The
                    remote browser is still running.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={reconnect}
                  >
                    Reconnect view
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div
          role={message ? "alert" : "status"}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center"
        >
          {waiting ? (
            <LoaderCircle
              className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Globe
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <div className="max-w-sm space-y-2">
            <p className="text-sm font-medium">{heading}</p>
            <p className="text-sm text-muted-foreground">
              {message ??
                (browser?.status === "closed"
                  ? onOpenActiveBrowser
                    ? "Another browser is still open on this task."
                    : "Send a task message to ask the agent to open another browser."
                  : browser?.status === "starting"
                    ? "The live view will appear here when it is ready."
                    : browser?.status === "stopping"
                      ? "Waiting for Browser Use to confirm shutdown."
                      : !viewable
                        ? "Ask the agent to browse a website in a task message."
                        : null)}
            </p>
          </div>
          {browser?.status === "closed" && !accessError && onOpenActiveBrowser && (
            <Button variant="outline" size="sm" onClick={onOpenActiveBrowser}>
              Open active browser
            </Button>
          )}
        </div>
      )}
      {viewable && url && viewer.view.kind === "stale" && (
        <QueryStaleHint className="px-3 py-2" />
      )}
      {viewable && url && message && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {message}
        </p>
      )}
      {viewable && presenceError && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          Could not keep this browser open. Check your connection before the
          timer runs out.
        </p>
      )}
      {viewable && viewport.error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {viewport.error}
        </p>
      )}
      {browser && !accessError && (
        <TaskBrowserFooter
          browser={browser}
          now={now}
          disabled={action.isPending}
          onControl={(value) => action.mutate(value)}
          onReconnect={reconnect}
          viewport={viewport.state.preset}
          controlledElsewhere={viewport.state.controlledElsewhere}
          resizing={viewport.resizing}
          resizeAvailable={viewerLoad === "loaded"}
          onResize={viewport.select}
        />
      )}
    </div>
  );
}
