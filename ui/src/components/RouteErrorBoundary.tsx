import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { onChunkLoadReloadAbandoned, reloadForChunkLoadError } from "@/lib/chunk-load-recovery";
import { captureBrowserException } from "@/lib/sentry";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

type RouteErrorBoundaryInnerProps = {
  resetKey: string;
  onReset: () => void;
  children: ReactNode;
};

type RouteErrorBoundaryState = {
  error: Error | null;
  reloading: boolean;
};

class RouteErrorBoundaryInner extends Component<RouteErrorBoundaryInnerProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { error: null, reloading: false };
  private stopWaitingForReload: (() => void) | null = null;

  static getDerivedStateFromError(error: unknown): Partial<RouteErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.stopWaiting();
    if (reloadForChunkLoadError(error)) {
      this.setState({ reloading: true });
      this.stopWaitingForReload = onChunkLoadReloadAbandoned(() => {
        this.stopWaitingForReload = null;
        this.setState({ reloading: false });
        this.report(error, info);
      });
      return;
    }
    this.report(error, info);
  }

  override componentWillUnmount(): void {
    this.stopWaiting();
  }

  private stopWaiting(): void {
    this.stopWaitingForReload?.();
    this.stopWaitingForReload = null;
  }

  private report(error: unknown, info: ErrorInfo): void {
    console.error("Page render failed", { error, componentStack: info.componentStack });
    captureBrowserException(error, { boundary: "route", componentStack: info.componentStack });
  }

  override componentDidUpdate(prevProps: RouteErrorBoundaryInnerProps): void {
    // A render throw with no boundary unmounts the whole app, so navigating
    // away (back button included) can't recover without a hard refresh. We sit
    // above the routed <Outlet />, so reset whenever the route changes.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.stopWaiting();
      this.setState({ error: null, reloading: false });
    }
  }

  override render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    if (reloading) return <PaperclipLoading className="min-h-full" />;

    return (
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-10">
        <div>
          <h1 className="text-lg font-semibold">This page hit an error</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Something went wrong while rendering this page. You can go back and try again, or reload.
          </p>
        </div>
        <pre className="overflow-auto rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
          {error.message}
        </pre>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={this.props.onReset}>
            Go back
          </Button>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </div>
    );
  }
}

export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const resetKey = `${location.pathname}${location.search}`;

  return (
    <RouteErrorBoundaryInner resetKey={resetKey} onReset={() => navigate(-1)}>
      <Suspense fallback={<PaperclipLoading className="min-h-full" />}>{children}</Suspense>
    </RouteErrorBoundaryInner>
  );
}
