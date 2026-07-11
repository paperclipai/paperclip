import { ServerCog, Wrench } from "lucide-react";
import { Link } from "@/lib/router";
import { advancedTabHref } from "@/pages/tools/tool-tabs";

/** Popular gallery keys surfaced first in the Browse store (PAP-13254, door 1). */
export const POPULAR_KEYS = ["zapier", "github", "slack", "notion", "linear"];

/**
 * First-class "Connect your own tool" card (PAP-12371, Finding C; PAP-13254).
 * Connection setup is intentionally unavailable until the integration is ready.
 */
export function ByoConnectCard({ disabled = false }: { disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full cursor-not-allowed items-center gap-4 rounded-xl border border-dashed border-border bg-card px-4 py-4 text-left opacity-60"
    >
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
        <ServerCog className="h-5 w-5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">Connect your own tool</div>
        <div className="text-xs text-muted-foreground">
          Custom and self-hosted tool connections are coming soon.
        </div>
      </div>
      <span className="shrink-0 text-xs font-semibold text-muted-foreground">Coming soon</span>
    </button>
  );
}

/** Labeled door to the developer control-plane (PAP-12371, Finding A cross-link). */
export function AdvancedToolsLink() {
  return (
    <Link
      to={advancedTabHref("run-your-own")}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <Wrench className="h-3.5 w-3.5" />
      Developer tools (advanced)
    </Link>
  );
}
