import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

type SectionErrorBoundaryProps = {
  /** Human label for the section, used in the fallback copy and logs (e.g. "Activity"). */
  label: string;
  /**
   * When this value changes the boundary resets and re-attempts a render. Pass a stable
   * identity for the surface (e.g. the issue id) so navigating to a new entity clears a
   * previously caught error.
   */
  resetKey?: string;
  /** Optional custom fallback. Falls back to a generic inline notice when omitted. */
  fallback?: ReactNode;
  children: ReactNode;
};

type SectionErrorBoundaryState = {
  hasError: boolean;
};

/**
 * Generic render-error boundary for a self-contained section of a page.
 *
 * A render-time exception in one section (a tab, a card, a feed row) would otherwise
 * propagate to the nearest ancestor boundary and blank the whole page — in the desktop
 * shell that surfaces as a crashed window. Wrapping a section keeps the failure local:
 * the section degrades to an inline notice while the rest of the page stays usable.
 */
export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  override state: SectionErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SectionErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${this.props.label} section failed to render; showing fallback`, {
      error,
      info: info.componentStack,
    });
  }

  override componentDidUpdate(prevProps: SectionErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-medium">This section couldn’t be displayed</div>
            <div className="mt-0.5 text-muted-foreground">
              Something went wrong rendering the {this.props.label.toLowerCase()}. The rest of the
              page is still usable.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
