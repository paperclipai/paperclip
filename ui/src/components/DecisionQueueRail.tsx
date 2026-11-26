import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { decisionQueuesApi } from "../api/decisionQueues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const RECENT_ACTIVITY_MS = 24 * 60 * 60 * 1000;

/** Href for a queue page under the current company prefix, or `/decisions` for All. */
export function decisionsHref(queueKey?: string | null): string {
  return queueKey ? `/decisions/queues/${encodeURIComponent(queueKey)}` : "/decisions";
}

interface DecisionQueueRailProps {
  companyId: string;
  /** The active queue key, or null when the desk (All) is active. */
  activeQueueKey?: string | null;
}

/**
 * Queue quicklinks (PAP-16032 §4.1 / wireframe screen 1, annotation 1). The
 * chips are *this company's queues*, ordered by most-recently-updated (the
 * server already sorts them that way) — not a hardcoded set of types. "All" is
 * the only fixed chip. A dot marks a queue with recent activity; the count is
 * the queue's pending items.
 */
export function DecisionQueueRail({ companyId, activeQueueKey = null }: DecisionQueueRailProps) {
  const { data: queues } = useQuery({
    queryKey: queryKeys.decisionQueues.list(companyId),
    queryFn: () => decisionQueuesApi.list(companyId),
    enabled: !!companyId,
  });

  // Nothing to show until at least one queue exists — the desk still works
  // without the rail, so render nothing rather than a lone "All" chip.
  if (!queues || queues.length === 0) {
    return null;
  }

  const now = Date.now();

  return (
    <nav className="flex flex-wrap items-center gap-1.5" aria-label="Decision queues" data-decision-queue-rail>
      <Chip href={decisionsHref(null)} active={activeQueueKey == null} label="All" />
      {queues.map((queue) => {
        const recent = now - new Date(queue.updatedAt).getTime() < RECENT_ACTIVITY_MS;
        return (
          <Chip
            key={queue.key}
            href={decisionsHref(queue.key)}
            active={activeQueueKey === queue.key}
            label={queue.title}
            count={queue.itemCount}
            recent={recent}
          />
        );
      })}
    </nav>
  );
}

function Chip({
  href,
  active,
  label,
  count,
  recent,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
  recent?: boolean;
}) {
  return (
    <Link
      to={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      {recent && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Recent activity" />
      )}
      <span className="truncate">{label}</span>
      {count != null && count > 0 && (
        <span className="tabular-nums text-(length:--text-nano) text-muted-foreground">{count}</span>
      )}
    </Link>
  );
}
