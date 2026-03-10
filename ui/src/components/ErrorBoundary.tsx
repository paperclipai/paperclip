import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("React ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(12,11,24,0.97)",
          color: "#e2e8f0",
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: "40px",
          overflowY: "auto",
          zIndex: 9999,
        }}
      >
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <h1 style={{ color: "#f87171", fontSize: 22, fontWeight: 600, marginBottom: 20 }}>
            Application Error
          </h1>
          <div
            style={{
              fontSize: 14,
              padding: 16,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid #f87171",
              borderRadius: 8,
              marginBottom: 16,
              wordBreak: "break-word",
            }}
          >
            {error.message}
          </div>
          {error.stack && (
            <pre
              style={{
                fontFamily: '"SF Mono", monospace',
                fontSize: 12,
                color: "#94a3b8",
                background: "rgba(0,0,0,0.3)",
                padding: 16,
                borderRadius: 8,
                marginBottom: 20,
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {error.stack}
            </pre>
          )}
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "10px 20px",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                background: "linear-gradient(135deg,#7c3aed,#6d28d9)",
                color: "white",
              }}
            >
              Reload
            </button>
            <button
              onClick={() => this.setState({ error: null })}
              style={{
                padding: "10px 20px",
                border: "1px solid #2d2860",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                background: "transparent",
                color: "#94a3b8",
              }}
            >
              Dismiss
            </button>
          </div>
          <p style={{ marginTop: 12, fontSize: 12, color: "#94a3b8", opacity: 0.6 }}>
            Press Ctrl/Cmd+R to reload
          </p>
        </div>
      </div>
    );
  }
}
