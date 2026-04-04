import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: "global" | "page";
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback === "page") {
      return (
        <div className="mx-auto max-w-xl py-10">
          <div className="rounded-lg border border-destructive/50 bg-card p-6">
            <h2 className="text-lg font-semibold text-destructive">Something went wrong</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <a href="/dashboard" className="mt-4 inline-block text-sm text-primary underline">
              Go to Dashboard
            </a>
          </div>
        </div>
      );
    }

    // Global fallback: plain inline styles (no provider dependencies)
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ textAlign: "center", maxWidth: 400, padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#666", marginBottom: 16 }}>
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer", border: "1px solid #ccc", borderRadius: 6, background: "#fff" }}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
