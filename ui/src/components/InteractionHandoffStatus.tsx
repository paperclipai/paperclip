import type { InteractionAwaitingHumanHandoffStatus } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, Loader2, Radio, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { handoffStatusTone } from "@/lib/interaction-handoff-status";

interface InteractionHandoffStatusProps {
  status: InteractionAwaitingHumanHandoffStatus;
}

function StatusIcon({ status }: { status: InteractionAwaitingHumanHandoffStatus }) {
  const className = "h-4 w-4 shrink-0";
  switch (status.phase) {
    case "checking":
      return <Loader2 className={cn(className, "animate-spin")} aria-hidden />;
    case "listening":
      return <Radio className={className} aria-hidden />;
    case "sending":
      return <Send className={className} aria-hidden />;
    case "completed":
      return <CheckCircle2 className={className} aria-hidden />;
    case "failed":
      return <AlertTriangle className={className} aria-hidden />;
    default:
      return <Radio className={cn(className, "opacity-60")} aria-hidden />;
  }
}

export function InteractionHandoffStatus({ status }: InteractionHandoffStatusProps) {
  return (
    <div
      className={cn(
        "mt-3 flex items-start gap-2.5 rounded-sm border px-3 py-2.5 text-sm",
        handoffStatusTone(status.phase),
      )}
      role="status"
      aria-live="polite"
      aria-label={status.label}
    >
      <StatusIcon status={status} />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium leading-5">{status.label}</div>
        {status.detail ? (
          <p className="text-xs leading-5 text-current/75">{status.detail}</p>
        ) : null}
      </div>
    </div>
  );
}
