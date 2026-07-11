import { ServerCog, Wrench } from "lucide-react";
import { Link } from "@/lib/router";
import { advancedTabHref } from "@/pages/tools/tool-tabs";

/** Popular gallery keys surfaced first in the Browse store (PAP-13254, door 1). */
export const POPULAR_KEYS = ["zapier", "github", "slack", "notion", "linear"];

/** Deep-link into the Connect wizard's bring-your-own-tool URL flow. */
export const BYO_CONNECT_HREF = "/apps/connect?byo=1";

/** Zapier connects with the complete MCP URL issued by Zapier. */
export const ZAPIER_CONNECT_HREF = "/apps/connect?byo=1&source=zapier";

/**
 * First-class "Connect your own tool" card (PAP-12371, Finding C; PAP-13254).
 * Lives in Browse as a persistent row and launches the guided URL flow.
 */
export function ByoConnectCard({ onConnect }: { onConnect: () => void }) {
  return (
    <button
      type="button"
      onClick={onConnect}
      className="flex w-full items-center gap-4 rounded-xl border border-dashed border-border bg-card px-4 py-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
    >
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
        <ServerCog className="h-5 w-5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">Connect your own tool</div>
        <div className="text-xs text-muted-foreground">
          Paste the URL from a custom or self-hosted MCP server and review its actions before enabling it.
        </div>
      </div>
      <span className="shrink-0 text-xs font-semibold text-primary">Connect →</span>
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
