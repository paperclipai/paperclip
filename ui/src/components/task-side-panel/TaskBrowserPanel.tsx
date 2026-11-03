import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type BrowserUseControl, type TaskBrowser } from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
import { Button } from "@/components/ui/button";
import { Globe, LoaderCircle } from "lucide-react";
import { useBrowserViewport } from "@/hooks/useBrowserViewport";
import { TaskBrowserFooter } from "./TaskBrowserFooter";

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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const viewable =
    browser && ["running", "idle"].includes(browser.status) && !accessError;
  const viewport = useBrowserViewport({
    issueId,
    browserId: browser?.id,
    enabled: Boolean(viewable && url && viewerLoad === "loaded"),
    active,
    frameRef,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!viewable || !browser) return;
    let disposed = false;
    const controller = new AbortController();
    // Keep the bearer viewer URL in component memory only. Revalidate even
    // when hidden so a revoked credential promptly unmounts its iframe.
    const load = () => {
      const version = viewport.version.current;
      return browserUseApi
        .viewer(issueId, browser.id, controller.signal, viewport.viewerId)
        .then((result) => {
          if (!disposed) {
            setUrl(result.url);
            setError(null);
            viewport.receive(
              result.viewportState ?? { preset: result.viewport ?? "fit" },
              version,
            );
          }
        })
        .catch(() => {
          if (!disposed) {
            setUrl(null);
            setError(
              "The live view disconnected. Use Reconnect view in Browser options to try again.",
            );
          }
        });
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 15000);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [issueId, browser?.id, viewable, refresh]);
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
    onError: () => setError("The browser action failed. Try again."),
  });
  const message = accessError
    ? "You no longer have access to this browser."
    : (browser?.error ?? error);
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
            : error
              ? "Live view disconnected"
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
      {viewable && url ? (
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
