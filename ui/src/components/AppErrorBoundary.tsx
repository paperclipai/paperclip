import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
  componentStack: string | null;
};

// Sits above <App /> in main.tsx, outside routing/layout, so it catches
// render throws from ANY component in the tree -- including ones that
// currently have no local boundary (route-less providers, Layout chrome,
// etc). Without this, an uncaught render error unmounts the whole React
// tree and leaves `<div id="root">` empty; since the app defaults to a dark
// theme, that reads to users as a plain black screen with no clue anything
// went wrong (RENA-52061 / RENA-55148).
//
// The fallback below intentionally does NOT rely on Tailwind theme classes
// or CSS custom properties (--background, --foreground, etc). If a theme
// variable is itself the reason for a crash, or the app crashed before the
// theme's CSS variables were applied to <html>, class-based styling could
// render invisible-on-invisible. Inline styles with hardcoded colors always
// render legibly regardless of theme state.
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      componentStack: null,
    };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error("Unhandled render error crashed the app", { error, componentStack: info.componentStack });
  }

  override render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2147483647,
          overflow: "auto",
          background: "#18181b",
          color: "#f4f4f5",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          padding: "2rem 1.5rem",
          boxSizing: "border-box",
        }}
      >
        <div style={{ maxWidth: "42rem", margin: "0 auto" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#a1a1aa" }}>
            The app hit an unexpected error while rendering and can&apos;t continue. Reloading usually
            fixes this; if it keeps happening, please share the details below.
          </p>
          <pre
            style={{
              marginTop: "1rem",
              overflow: "auto",
              borderRadius: "0.375rem",
              border: "1px solid #f87171",
              background: "rgba(248, 113, 113, 0.12)",
              color: "#fca5a5",
              padding: "0.75rem",
              fontSize: "0.75rem",
              whiteSpace: "pre-wrap",
            }}
          >
            {error.message}
          </pre>
          {componentStack ? (
            <details style={{ marginTop: "0.75rem" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.8125rem", color: "#a1a1aa" }}>
                Component stack
              </summary>
              <pre
                style={{
                  marginTop: "0.5rem",
                  overflow: "auto",
                  borderRadius: "0.375rem",
                  border: "1px solid #3f3f46",
                  background: "#27272a",
                  color: "#d4d4d8",
                  padding: "0.75rem",
                  fontSize: "0.75rem",
                  whiteSpace: "pre-wrap",
                }}
              >
                {componentStack}
              </pre>
            </details>
          ) : null}
          <div style={{ marginTop: "1.25rem" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                border: "1px solid #52525b",
                borderRadius: "0.375rem",
                background: "#3f3f46",
                color: "#f4f4f5",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                cursor: "pointer",
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
