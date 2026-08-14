import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryState = {
  error: Error | null;
};

/**
 * Last-resort boundary above the router and every provider that renders app
 * chrome. `RouteErrorBoundary` only guards the routed `<Outlet />`; a crash in
 * the shell around it (sidebar, providers, layout hooks) has no boundary, so
 * React unmounts the entire root and the user is left staring at a blank
 * page with no way forward but knowing to hard-refresh. This boundary trades
 * that blank page for a reload prompt.
 *
 * Deliberately dependency-free: no router, no toast, no query client — the
 * crash being handled may have originated inside any of those providers.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("App shell crashed", { error, componentStack: info.componentStack });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center space-y-4 px-4 py-10">
        <div>
          <h1 className="text-lg font-semibold">Paperclip hit an error</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Something went wrong while running the app. Reloading usually fixes this.
          </p>
        </div>
        <pre className="overflow-auto rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
          {error.message}
        </pre>
        <div>
          <button
            type="button"
            className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
