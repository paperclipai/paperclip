import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, MessageSquareWarning, PauseCircle } from "lucide-react";
import type { OperatorDigest, OperatorDigestState } from "../lib/operator-digest";
import { cn } from "../lib/utils";

interface OperatorDigestCardProps {
  digest: OperatorDigest;
}

const STATE_TONE: Record<OperatorDigestState, {
  container: string;
  badge: string;
  icon: typeof AlertTriangle;
}> = {
  needs_you: {
    container: "border-amber-500/30 bg-amber-500/[0.08]",
    badge: "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200",
    icon: MessageSquareWarning,
  },
  ready_review: {
    container: "border-emerald-500/30 bg-emerald-500/[0.07]",
    badge: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
    icon: CheckCircle2,
  },
  running: {
    container: "border-cyan-500/30 bg-cyan-500/[0.07]",
    badge: "border-cyan-500/40 bg-cyan-500/15 text-cyan-800 dark:text-cyan-200",
    icon: Loader2,
  },
  blocked: {
    container: "border-red-500/30 bg-red-500/[0.07]",
    badge: "border-red-500/40 bg-red-500/15 text-red-800 dark:text-red-200",
    icon: AlertTriangle,
  },
  quiet: {
    container: "border-border bg-muted/20",
    badge: "border-border bg-background text-muted-foreground",
    icon: PauseCircle,
  },
};

export function OperatorDigestCard({ digest }: OperatorDigestCardProps) {
  const tone = STATE_TONE[digest.state];
  const Icon = tone.icon;

  return (
    <section
      className={cn(
        "rounded-lg border px-4 py-3",
        tone.container,
      )}
      aria-label="Operator digest"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                tone.badge,
              )}
            >
              <Icon className={cn("h-3.5 w-3.5", digest.state === "running" && "animate-spin")} />
              {digest.label}
            </span>
            <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Operator Digest
            </span>
          </div>
          <p className="text-sm font-medium leading-6 text-foreground">{digest.oneLiner}</p>
        </div>
      </div>

      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-medium text-muted-foreground">Human action</dt>
          <dd className="mt-1 leading-5 text-foreground">{digest.humanAction}</dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">Next step</dt>
          <dd className="mt-1 leading-5 text-foreground">{digest.nextStep}</dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">Latest change</dt>
          <dd className="mt-1 leading-5 text-foreground">{digest.latestChange}</dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">Risk</dt>
          <dd className="mt-1 leading-5 text-foreground">{digest.risk}</dd>
        </div>
      </dl>

      {digest.evidence.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Evidence</span>
          {digest.evidence.map((item) => item.href ? (
            <a
              key={`${item.label}:${item.href}`}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background/70 px-2 py-1 text-[11px] text-foreground hover:bg-background"
            >
              <span className="truncate">{item.label}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <span
              key={item.label}
              className="inline-flex max-w-full rounded-md border border-border bg-background/70 px-2 py-1 text-[11px] text-foreground"
            >
              <span className="truncate">{item.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
