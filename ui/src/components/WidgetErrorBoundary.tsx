import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback UI. */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * A lightweight error boundary that catches render errors in a section
 * and shows a friendly fallback with a retry button - without crashing
 * the rest of the page.
 */
export class WidgetErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[WidgetErrorBoundary${this.props.label ? ` - ${this.props.label}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-border bg-muted/30 p-6 flex flex-col items-center gap-3 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
          <div>
            <p className="text-sm font-medium">Something went wrong</p>
            {this.props.label && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Failed to load {this.props.label}
              </p>
            )}
            {this.state.error?.message && (
              <p className="text-xs text-muted-foreground mt-1 font-mono max-w-sm truncate">
                {this.state.error.message}
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={this.handleRetry}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
