import { ArrowUpRight, Puzzle } from "lucide-react";
import { Link } from "@/lib/router";

interface PluginDiscoveryCardProps {
  installedCount?: number;
  exampleCount?: number;
}

function getPluginDiscoveryDescription(installedCount?: number, exampleCount?: number): string {
  if ((installedCount ?? 0) > 0) {
    if ((exampleCount ?? 0) > 0) {
      return `${installedCount} installed. ${exampleCount} bundled examples are also available to browse and install.`;
    }
    return `${installedCount} installed. Open Plugin Manager to configure, enable, disable, or install more plugins.`;
  }

  if ((exampleCount ?? 0) > 0) {
    return `${exampleCount} bundled examples are ready to browse and install from Plugin Manager.`;
  }

  return "Browse available plugins, install them from the UI, and manage enable or disable state from Plugin Manager.";
}

export function PluginDiscoveryCard({ installedCount, exampleCount }: PluginDiscoveryCardProps) {
  return (
    <Link
      to="/instance/settings/plugins"
      className="group block rounded-xl border border-border bg-card p-5 text-inherit no-underline shadow-sm transition-colors hover:bg-accent/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg border border-border/70 bg-background/80 p-2 text-muted-foreground">
              <Puzzle className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium uppercase tracking-wide">Plugins</span>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                Alpha
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <h3 className="text-base font-semibold text-foreground">Discover and manage plugins</h3>
            <p className="text-sm leading-6 text-muted-foreground">
              {getPluginDiscoveryDescription(installedCount, exampleCount)}
            </p>
          </div>
        </div>

        <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </div>
    </Link>
  );
}

export { getPluginDiscoveryDescription };
