import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";

type RouteErrorBoundaryInnerProps = {
  resetKey: string;
  onReset: () => void;
  children: ReactNode;
};

type RouteErrorBoundaryState = {
  error: Error | null;
};

class RouteErrorBoundaryInner extends Component<RouteErrorBoundaryInnerProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Page render failed", { error, componentStack: info.componentStack });
  }

  override componentDidUpdate(prevProps: RouteErrorBoundaryInnerProps): void {
    // A render throw with no boundary unmounts the whole app, so navigating
    // away (back button included) can't recover without a hard refresh. We sit
    // above the routed <Outlet />, so reset whenever the route changes.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

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
      {children}
    </RouteErrorBoundaryInner>
  );
}
