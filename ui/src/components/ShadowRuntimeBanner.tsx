import type { ServerRuntimeInfo } from "@paperclipai/shared";
import { Layers3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

function describeSource(runtime: ServerRuntimeInfo): string {
  if (runtime.shadowSourcePort !== null) return `${runtime.shadowSourcePort}`;
  if (runtime.shadowSourceApi) return runtime.shadowSourceApi;
  return "source";
}

export function ShadowRuntimeBanner({ runtime }: { runtime?: ServerRuntimeInfo }) {
  if (!runtime || runtime.role !== "shadow") return null;

  const targetPortLabel = runtime.targetPort !== null ? String(runtime.targetPort) : "shadow port";
  const source = describeSource(runtime);

  return (
    <div className="border-b border-border bg-muted/40 text-foreground">
      <div className="flex flex-col gap-2 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
            <Layers3 className="h-3.5 w-3.5 shrink-0" />
            <span>Shadow Runtime</span>
            <Badge variant="secondary" className="text-(length:--text-nano) tracking-(--tracking-eyebrow)">
              Source Owns Background Work
            </Badge>
          </div>
          <p className="mt-1 text-sm">
            Shadow dev server on {targetPortLabel}, using {source} database, background schedulers disabled.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {runtime.shadowSourceApi ? `Source API ${runtime.shadowSourceApi} · ` : ""}
            Scheduler and backup ownership stay with the source server.
          </p>
        </div>
      </div>
    </div>
  );
}
