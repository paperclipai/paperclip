import { useTranslation, t as translate } from "@/i18n";
import { useMemo } from "react";
import {
  humanizeConnectionDisplayName,
  type Agent,
  type ToolCallEvent,
  type ToolConnectionLifecycleEvent,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { appTabHref } from "../app-tabs";
import type { ActivityPanelProps } from "./types";

export function ActivityPanel(props: ActivityPanelProps) {
  return <RecentActivity {...props} />;
}

type TimelineRow = {
  key: string;
  createdAt: Date | string;
  primary: string;
  dotClass: string;
  /** Secondary "while working on PAP-…" issue link, tool-call rows only. */
  issue?: { identifier: string } | null;
  /** Deep-link rendered after the timestamp, lifecycle rows only. */
  link?: { to: string; label: string } | null;
};

function RecentActivity({
  events,
  lifecycleEvents,
  issues,
  actionRequests,
  loading,
  agents,
  connectionId,
  appName,
  userLabelById,
}: ActivityPanelProps) {
  const { t } = useTranslation("connections");
  const nameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents, t]);

  const rows = useMemo<TimelineRow[]>(() => {
    const callRows: TimelineRow[] = events
      .filter((e) => HUMANIZED_EVENTS.has(e.eventType))
      .map((event) => {
        const row = humanizeEvent(
          event,
          nameById.get(event.agentId ?? "") ?? null,
          event.actionRequestId ? actionRequests[event.actionRequestId] : undefined,
          isTestEvent(event) ? resolveActorLabel(event.actorId, userLabelById) : null,
        );
        return {
          key: `call:${event.id}`,
          createdAt: event.createdAt,
          primary: row.primary,
          dotClass: dotColor(event),
          issue: event.issueId ? issues[event.issueId] ?? null : null,
        };
      });

    const permissionsHref = appTabHref(connectionId, "permissions");
    const lifecycleRows: TimelineRow[] = lifecycleEvents.map((event) => ({
      key: `lifecycle:${event.id}`,
      createdAt: event.createdAt,
      primary: humanizeLifecycleEvent(event, appName, nameById.get(event.agentId ?? "") ?? null),
      dotClass: lifecycleDotColor(event),
      link: { to: permissionsHref, label: lifecycleLinkLabel(event) },
    }));

    return [...callRows, ...lifecycleRows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [events, lifecycleEvents, issues, actionRequests, nameById, connectionId, appName, userLabelById, t]);

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("recent_activity_72d5617")}</h2>
      </div>
      {loading ? (
        <div className="space-y-2 py-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-5 text-sm text-muted-foreground">{t("no_activity_yet_8bdea32")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.key} className="flex items-start gap-3 py-3 text-sm">
              <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", row.dotClass)} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-foreground">{row.primary}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {row.issue ? (
                    <>{t("while_working_on_40c4aae")}{" "}
                      <Link
                        to={`/issues/${row.issue.identifier}`}
                        className="font-medium text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {row.issue.identifier}
                      </Link>
                      {" · "}
                    </>
                  ) : null}
                  {timeAgo(row.createdAt)}
                  {row.link ? (
                    <>
                      {" · "}
                      <Link
                        to={row.link.to}
                        className="font-medium text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {row.link.label}
                      </Link>
                    </>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const HUMANIZED_EVENTS = new Set<ToolCallEvent["eventType"]>([
  "call_completed",
  "call_failed",
  "call_denied",
  "approval_requested",
  "approval_resolved",
]);

/**
 * A row is a prosumer Test-tab call (vs. a real heartbeat-driven agent run) when
 * the gateway tagged the audit event `metadata.source === "test"` (PAP-11349).
 */
export function isTestEvent(event: ToolCallEvent): boolean {
  return (event.metadata as { source?: unknown } | null)?.source === "test";
}

/** Display name for the human who ran a Test-tab call, from the company directory. */
export function resolveActorLabel(
  actorId: string | null,
  userLabelById: Map<string, string> | undefined,
): string {
  if (actorId) {
    const label = userLabelById?.get(actorId);
    if (label) return label;
    if (actorId === "local-board") return translate("connections:board_e879b0b");
  }
  return translate("connections:someone_35bb097");
}

export function humanizeEvent(
  event: ToolCallEvent,
  agentName: string | null,
  actionRequest?: ActivityPanelProps["actionRequests"][string],
  /** When set, this row is a Test-tab call run by the named user; prefix accordingly. */
  testRunnerLabel?: string | null,
): { primary: string } {
  // For Test-tab calls, surface "<User> tested as <Agent>" so prosumer test runs are
  // distinguishable from real heartbeat agent activity in the audit trail (PAP-11415).
  const who = testRunnerLabel
    ? translate("connections:tested_as_4cf2c48", { testRunnerLabel: testRunnerLabel, value: agentName ?? translate("connections:an_agent_14ff038") })
    : agentName ?? translate("connections:an_agent_d95187e");
  // The raw gateway tool name is prefixed (e.g. `mcp.app-gallery-link-…:kv-set`);
  // humanize it to "Kv Set" to match the cross-app Activity view (PAP-11105).
  const action = event.toolName ? humanizeConnectionDisplayName(event.toolName) : translate("connections:an_action_c58b488");
  switch (event.eventType) {
    case "call_completed":
      return {
        primary: event.outcome === "success"
          ? translate("connections:used_337b933", { who: who, action: action })
          : translate("connections:ran_but_it_didn_t_finish_a2764bd", { who: who, action: action }),
      };
    case "call_failed":
      return { primary: translate("connections:didn_t_work_for_991214e", { action: action, lower: lower(who) }) };
    case "call_denied":
      return {
        primary: testRunnerLabel
          ? translate("connections:is_turned_off_04759c1", { who: who, action: action })
          : translate("connections:blocked_it_isn_t_turned_on_f5a0776", { action: action }),
      };
    case "approval_requested":
      return { primary: translate("connections:asked_before_running_2626807", { who: who, action: action }) };
    case "approval_resolved":
      return { primary: humanizeApprovalResolved(action, actionRequest) };
    default:
      return { primary: translate("connections:used_337b933", { who: who, action: action }) };
  }
}

function humanizeApprovalResolved(
  action: string,
  actionRequest?: ActivityPanelProps["actionRequests"][string],
): string {
  const resolver = actionRequest?.resolverDisplayName ?? translate("connections:someone_35bb097");
  if (actionRequest?.status === "approved") return translate("connections:approved_f86b14c", { resolver: resolver, action: action });
  if (actionRequest?.status === "rejected") return translate("connections:said_no_to_43b7c63", { resolver: resolver, action: action });
  return translate("connections:reviewed_465b548", { resolver: resolver, action: action });
}

/** Humanize a connection lifecycle event into a prosumer sentence (PAP-11284). */
function humanizeLifecycleEvent(
  event: ToolConnectionLifecycleEvent,
  appName: string,
  agentName: string | null,
): string {
  const who = event.actorDisplayName ?? agentName ?? translate("connections:someone_35bb097");
  switch (event.type) {
    case "app_connected":
      return translate("connections:connected_c217874", { who: who, appName: appName });
    case "app_paused":
      return translate("connections:paused_this_app_50bbb8c", { who: who });
    case "app_resumed":
      return translate("connections:resumed_this_app_72f6373", { who: who });
    case "reconnected":
      return translate("connections:reconnected_d381e6b", { who: who, appName: appName });
    case "disconnected":
      return translate("connections:disconnected_61537ad", { who: who, appName: appName });
    case "allowlist_changed":
      return humanizeAllowlistChange(who, event.details);
    case "actions_quarantined": {
      const count = numberFrom(event.details?.count);
      return translate("connections:new_need_review_eece727", { count: count, value: count === 1 ? "action" : "actions" });
    }
    default:
      return translate("connections:updated_this_app_2c1d378", { who: who });
  }
}

function humanizeAllowlistChange(who: string, details: Record<string, unknown> | null): string {
  const added = numberFrom(details?.added);
  const removed = numberFrom(details?.removed);
  if (added > 0 && removed === 0) {
    return translate("connections:added_to_the_allowlist_db5bfa5", { who, count: added });
  }
  if (removed > 0 && added === 0) {
    return translate("connections:removed_from_the_allowlist_153a97a", { who, count: removed });
  }
  if (added > 0 && removed > 0) {
    return translate("connections:updated_the_allowlist_added_removed_601a3dd", { who: who, added: added, removed: removed });
  }
  return translate("connections:updated_the_allowlist_7404713", { who: who });
}

function lifecycleLinkLabel(event: ToolConnectionLifecycleEvent): string {
  return event.type === "actions_quarantined" ? translate("connections:review_permissions_dee17ec") : translate("connections:view_permissions_9032001");
}

function numberFrom(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function lower(who: string): string {
  return who === "An agent" ? translate("connections:an_agent_14ff038") : who;
}

function dotColor(event: ToolCallEvent): string {
  if (event.eventType === "call_failed" || event.outcome === "failure" || event.outcome === "timeout") {
    return "bg-red-400";
  }
  if (event.eventType === "call_denied" || event.outcome === "denied") return "bg-amber-400";
  if (event.eventType === "approval_requested") return "bg-amber-400";
  return "bg-emerald-400";
}

function lifecycleDotColor(event: ToolConnectionLifecycleEvent): string {
  if (event.type === "disconnected") return "bg-red-400";
  if (event.type === "app_paused" || event.type === "actions_quarantined") return "bg-amber-400";
  return "bg-emerald-400";
}
