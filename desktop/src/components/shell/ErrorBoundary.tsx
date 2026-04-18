import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
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

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-16 text-center">
          <div className="text-[48px] opacity-30">!</div>
          <h2 className="text-lg font-medium" style={{ color: "var(--fg)" }}>
            Something went wrong
          </h2>
          <p className="max-w-md text-sm" style={{ color: "var(--fg-muted)" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            className="rounded-md border px-4 py-2 text-sm font-medium transition-colors"
            style={{
              borderColor: "var(--border)",
              color: "var(--fg-secondary)",
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
