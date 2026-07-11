import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Eye, LoaderCircle, WifiOff } from "lucide-react";
import { cn } from "../lib/utils";

type StreamStatus = "waiting" | "live" | "disconnected";

interface LiveBrowserPreviewProps {
  runId: string;
  agentName?: string | null;
}

export function LiveBrowserPreview({ runId, agentName }: LiveBrowserPreviewProps) {
  const [status, setStatus] = useState<StreamStatus>("waiting");
  const [frame, setFrame] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setStatus("waiting");
    setFrame(null);
    const source = new EventSource(`/api/heartbeat-runs/${encodeURIComponent(runId)}/browser-stream`);
    source.addEventListener("status", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { status?: StreamStatus };
        if (payload.status) setStatus(payload.status);
      } catch {
        setStatus("disconnected");
      }
    });
    source.addEventListener("frame", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { data?: unknown };
        if (typeof payload.data !== "string") return;
        const nextFrame = `data:image/jpeg;base64,${payload.data}`;
        setFrame(nextFrame);
        setStatus("live");
      } catch {
        // Keep the last good frame visible.
      }
    });
    source.onerror = () => setStatus("disconnected");
    return () => source.close();
  }, [runId]);

  const statusLabel = status === "live" ? "Live" : status === "waiting" ? "Waiting for browser" : "Reconnecting";

  if (!frame) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-sky-500/25 bg-slate-950 text-slate-100 shadow-[0_20px_60px_rgba(2,132,199,0.12)]" data-testid="live-browser-preview">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center justify-between gap-3 border-b border-white/10 bg-white/[0.04] px-4 py-3 text-left"
        aria-expanded={!collapsed}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-400/15 text-sky-300">
            <Eye className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Live browser</span>
            <span className="block truncate text-xs text-slate-400">
              {agentName ? `${agentName} · ` : ""}agent-browser
            </span>
          </span>
        </span>
        <span className="flex items-center gap-3">
          <span className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            status === "live" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/10 text-slate-300",
          )}>
            {status === "live" ? <span className="size-1.5 animate-pulse rounded-full bg-emerald-300" /> : status === "waiting" ? <LoaderCircle className="size-3 animate-spin" /> : <WifiOff className="size-3" />}
            {statusLabel}
          </span>
          {collapsed ? <ChevronDown className="size-4 text-slate-400" /> : <ChevronUp className="size-4 text-slate-400" />}
        </span>
      </button>

      {!collapsed ? (
        <div className="relative aspect-video min-h-48 w-full bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.08),transparent_55%)]">
          <img src={frame} alt="Live agent browser viewport" className="h-full w-full object-contain" />
        </div>
      ) : null}
    </section>
  );
}
