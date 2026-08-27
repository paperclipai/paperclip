import type { PullAgentLifecycle, PullAgentLifecycleState } from "@paperclipai/shared";
import { AgentStatusBadge } from "./StatusBadge";
import { relativeTime } from "../lib/utils";

const STATE_COPY: Record<PullAgentLifecycleState, string> = {
  running: "A resident seat reported live process evidence.",
  idle: "A fresh lease is present and no queued assigned work is visible.",
  idle_queued: "A fresh lease is present and assigned work is waiting.",
  blocked: "The last report, or assigned issues, say this seat is blocked.",
  unreachable: "No fresh pull-lease has arrived inside the TTL window.",
};

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatPullLifecycleObserved(value: Date | string | null | undefined): string {
  const date = asDate(value);
  return date ? relativeTime(date) : "never";
}

export function PullAgentLifecycleCard({ lifecycle }: { lifecycle: PullAgentLifecycle }) {
  const expiresAt = asDate(lifecycle.expiresAt);
  const evidence = lifecycle.evidence ?? [];
  return (
    <section
      aria-label="Pull-agent lifecycle"
      className="border border-border rounded-lg p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Pull lifecycle</h3>
          <p className="text-xs text-muted-foreground">
            {STATE_COPY[lifecycle.state] ?? "Derived from the last resident-seat lease."}
          </p>
        </div>
        <AgentStatusBadge status={lifecycle.state} />
      </div>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="font-medium truncate">{lifecycle.source ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Observed</dt>
          <dd className="font-medium">{formatPullLifecycleObserved(lifecycle.observedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Lease expires</dt>
          <dd className="font-medium">{expiresAt ? relativeTime(expiresAt) : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Heartbeat dispatch</dt>
          <dd className="font-medium">{lifecycle.dispatchEnabled ? "enabled" : "disabled"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Queued assigned</dt>
          <dd className="font-medium tabular-nums">{lifecycle.queuedIssueCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Blocked assigned</dt>
          <dd className="font-medium tabular-nums">{lifecycle.blockedIssueCount}</dd>
        </div>
      </dl>
      {evidence.length > 0 && (
        <ul className="space-y-1 text-xs">
          {evidence.map((item, index) => (
            <li
              key={`${item.kind}-${item.id ?? index}`}
              className="flex items-center justify-between gap-2 text-muted-foreground"
            >
              <span className="truncate">
                {item.kind.replace(/_/g, " ")}
                {item.id ? ` · ${item.id}` : ""}
                {item.detail ? ` — ${item.detail}` : ""}
              </span>
              <span className="shrink-0">{item.active ? "active" : "inactive"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
