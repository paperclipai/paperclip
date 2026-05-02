import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PageErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <p className="text-sm text-destructive font-medium">页面渲染出错</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            {this.state.error.message || "未知错误"}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          >
            刷新页面
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
