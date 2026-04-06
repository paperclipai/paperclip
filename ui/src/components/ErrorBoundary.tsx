import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
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

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex flex-col items-center justify-center min-h-screen p-8 text-center">
            <div className="max-w-md space-y-4">
              <h1 className="text-2xl font-[var(--font-display)] uppercase tracking-[0.06em] text-foreground">Something went wrong</h1>
              <p className="text-muted-foreground">
                {this.state.error?.message || "An unexpected error occurred."}
              </p>
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
                className="px-4 py-2 text-sm font-[var(--font-mono)] font-medium text-white bg-primary rounded-[2px] hover:bg-primary/90"
              >
                Reload page
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
