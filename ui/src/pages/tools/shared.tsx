import { t as finalPagesT } from "@/i18n";
import { t as translateAgentPage, useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import type {
  ToolRiskLevel,
  ToolConnectionHealthStatus,
  ToolPolicyDecision,
} from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorState } from "@/components/QueryView";
import { StatusBadge } from "@/components/StatusBadge";

/** Risk classification badge for a catalog tool. */
export function RiskBadge({ risk }: { risk: ToolRiskLevel | null | undefined }) {
  const { t: translateAgentPage } = useTranslation("agents");
  if (!risk) return <Badge variant="outline">{translateAgentPage("agents:unknown")}</Badge>;
  const variant =
    risk === "high" || risk === "critical"
      ? "destructive"
      : risk === "medium"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{risk}</Badge>;
}

/** Read/Write/Destructive capability chips. */
export function CapabilityBadges({
  isReadOnly,
  isWrite,
  isDestructive,
}: {
  isReadOnly?: boolean;
  isWrite?: boolean;
  isDestructive?: boolean;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <span className="inline-flex flex-wrap gap-1">
      {isReadOnly ? <Badge variant="outline">{translateAgentPage("agents:read_only_1d8d39")}</Badge> : null}
      {isWrite ? <Badge variant="secondary">{translateAgentPage("agents:write")}</Badge> : null}
      {isDestructive ? <Badge variant="destructive">{translateAgentPage("agents:destructive_10f096")}</Badge> : null}
    </span>
  );
}

/** Catalog quarantine marker — canonical status key. */
export function QuarantineBadge() {
  return <StatusBadge status="quarantined" />;
}

function healthToStatusKey(status: string): string {
  switch (status) {
    case "healthy":
    case "ok":
    case "":
      return "healthy";
    case "degraded":
    case "warning":
      return "degraded";
    case "error":
    case "unhealthy":
    case "critical":
      return "runtime-error";
    case "unchecked":
    case "unknown":
      return "unchecked";
    default:
      return status;
  }
}

/** Connection / runtime health badge, mapped onto canonical status colors. */
export function HealthBadge({
  status,
  label,
}: {
  status: ToolConnectionHealthStatus | string | null | undefined;
  label?: string;
}) {
  const raw = (status ?? "unknown").toString();
  return <StatusBadge status={healthToStatusKey(raw)} label={label ?? raw} />;
}

function decisionToStatusKey(decision: string): { key: string; label: string } {
  switch (decision) {
    case "allow":
    case "allowed":
      return { key: "allowed", label: translateAgentPage("agents:allowed_c3de44") };
    case "deny":
    case "denied":
      return { key: "denied", label: translateAgentPage("agents:denied") };
    case "block":
      return { key: "block", label: translateAgentPage("agents:block_0214b4") };
    case "require_approval":
    case "requires_approval":
      return { key: "require-approval", label: translateAgentPage("agents:require_approval") };
    case "redact":
    case "redacted":
      return { key: "redacted", label: translateAgentPage("agents:redacted") };
    case "rate_limited":
      return { key: "rate-limit", label: translateAgentPage("agents:rate_limited") };
    case "defer":
    case "deferred":
      return { key: "deferred", label: translateAgentPage("agents:deferred") };
    case "hidden":
      return { key: "hidden", label: translateAgentPage("agents:hidden") };
    default:
      return { key: decision, label: decision };
  }
}

/** Policy/gateway decision badge — canonical status colors. */
export function DecisionBadge({ decision }: { decision: ToolPolicyDecision | string | null | undefined }) {
  if (!decision) return <Badge variant="outline">—</Badge>;
  const { key, label } = decisionToStatusKey(decision.toString());
  return <StatusBadge status={key} label={label} />;
}

/** Compact relative time, falling back to absolute. */
export function RelativeTime({ value }: { value: Date | string | null | undefined }) {
  const { t: translateAgentPage } = useTranslation("agents");
  if (!value) return <span className="text-muted-foreground">{translateAgentPage("agents:never")}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span className="text-muted-foreground">—</span>;
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const isFuture = diffMs < 0;
  let text: string;
  if (mins < 1) text = translateAgentPage("agents:just_now");
  else {
    const value =
      mins < 60 ? finalPagesT("final-pages:value_m_99b6e8", { value: mins }) : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
    text = isFuture ? `in ${value}` : translateAgentPage("agents:ago", { value1: value });
  }
  return (
    <span title={date.toLocaleString()} className="text-muted-foreground">
      {text}
    </span>
  );
}

export function ToolsPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      {label ?? translateAgentPage("agents:loading")}
    </div>
  );
}

/**
 * Compatibility wrapper over the shared `QueryErrorState`. Reads in this folder
 * gate on `useQueryView` and render `QueryErrorState` directly; this stays
 * exported only because `ui/src/pages/AgentToolsTab.tsx` (owned by another
 * task) still imports it. Remove after that migration lands.
 */
export function ErrorState({
  error,
  onRetry,
  action,
}: {
  error: unknown;
  onRetry?: () => void;
  action?: string;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  return <QueryErrorState error={error} action={action ?? translateAgentPage("agents:load_tools_access")} onRetry={onRetry} size="panel" />;
}

/**
 * Honest notice for surfaces whose backend contract has not shipped yet.
 * This must NOT pretend to enforce anything client-side — it links the
 * follow-up issue that owns the missing contract.
 */
export function PendingBackendNotice({
  title,
  body,
  issue,
}: {
  title: string;
  body: ReactNode;
  issue?: { identifier: string; href: string };
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col gap-2 py-8">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {title}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{body}</p>
        {issue ? (
          <a href={issue.href} className="text-sm font-medium text-primary hover:underline">{translateAgentPage("agents:tracked_in")}{" "}{issue.identifier} →
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Closed first-party values only; unrecognized provider/diagnostic values stay raw. */
const PAGE_VALUE_LABELS: Record<string, () => string> = {
"active": () => finalPagesT("final-pages:active_968796"),
"inactive": () => finalPagesT("final-pages:inactive_d10226"),
"enabled": () => finalPagesT("final-pages:enabled_fb9cf7"),
"disabled": () => finalPagesT("final-pages:disabled_17eb3c"),
"draft": () => finalPagesT("final-pages:draft_7743ce"),
"archived": () => finalPagesT("final-pages:archived_dd9e88"),
"pending": () => finalPagesT("final-pages:pending_62a2fe"),
"running": () => finalPagesT("final-pages:running_c071cf"),
"queued": () => finalPagesT("final-pages:queued_d36be6"),
"succeeded": () => finalPagesT("final-pages:succeeded_5dceae"),
"failed": () => finalPagesT("final-pages:failed_5d28a9"),
"cancelled": () => finalPagesT("final-pages:cancelled_8b4704"),
"error": () => finalPagesT("final-pages:error_ca00fc"),
"healthy": () => finalPagesT("final-pages:healthy_87695f"),
"unhealthy": () => finalPagesT("final-pages:unhealthy_858260"),
"ready": () => finalPagesT("final-pages:ready_b24d6d"),
"starting": () => finalPagesT("final-pages:starting_59dbf3"),
"stopping": () => finalPagesT("final-pages:stopping_9ea904"),
"stopped": () => finalPagesT("final-pages:stopped_8322e8"),
"restarting": () => finalPagesT("final-pages:restarting_818c2a"),
"disconnected": () => finalPagesT("final-pages:disconnected_d0cb8d"),
"connected": () => finalPagesT("final-pages:connected_12a7bd"),
"expired": () => finalPagesT("final-pages:expired_fa64ea"),
"revoked": () => finalPagesT("final-pages:revoked_4bb47f"),
"needs_reauthorization": () => finalPagesT("final-pages:needs_reauthorization_9f0fff"),
"allow": () => finalPagesT("final-pages:allow_410083"),
"deny": () => finalPagesT("final-pages:deny_3026a0"),
"require_approval": () => finalPagesT("final-pages:require_approval_25abb8"),
"redact": () => finalPagesT("final-pages:redact_18f125"),
"rate_limit": () => finalPagesT("final-pages:rate_limit_3084e8"),
"folders": () => finalPagesT("final-pages:folders_63b853"),
"flat": () => finalPagesT("final-pages:flat_5dc27a"),
"tools": () => finalPagesT("final-pages:tools_f9d35d"),
"resources": () => finalPagesT("final-pages:resources_41d311"),
"prompts": () => finalPagesT("final-pages:prompts_eb7526"),
"quarantined": () => finalPagesT("final-pages:quarantined_c3ecfc"),
"installed": () => finalPagesT("final-pages:installed_a51a6c"),
"uninstalled": () => finalPagesT("final-pages:uninstalled_785748"),
"paused": () => finalPagesT("final-pages:paused_a7a9dc"),
"idle": () => finalPagesT("final-pages:idle_4fb623"),
"terminated": () => finalPagesT("final-pages:terminated_e8c95a"),
"todo": () => finalPagesT("final-pages:todo_602fae"),
"in_progress": () => finalPagesT("final-pages:in_progress_01734f"),
"in_review": () => finalPagesT("final-pages:in_review_445887"),
"done": () => finalPagesT("final-pages:done_a4c3ed"),
"blocked": () => finalPagesT("final-pages:blocked_6973dd"),
"open": () => finalPagesT("final-pages:open_2348f9"),
"closed": () => finalPagesT("final-pages:closed_c3eefb"),
"live": () => finalPagesT("final-pages:live_247610"),
"closing-soon": () => finalPagesT("final-pages:closing_soon_daff7c"),
"complete": () => finalPagesT("final-pages:complete_eebbf6"),
"completed": () => finalPagesT("final-pages:completed_4ddb3e"),
"waiting": () => finalPagesT("final-pages:waiting_80cfa3"),
"monitoring": () => finalPagesT("final-pages:monitoring_14a232"),
"uploading": () => finalPagesT("final-pages:uploading_39e15e"),
"downloading": () => finalPagesT("final-pages:downloading_740223"),
"transferring": () => finalPagesT("final-pages:transferring_09cac8"),
"preparing": () => finalPagesT("final-pages:preparing_d932d9"),
"resolved": () => finalPagesT("final-pages:resolved_dc676b"),
"unavailable": () => finalPagesT("final-pages:unavailable_ba691b"),
"degraded": () => finalPagesT("final-pages:degraded_3c8cab"),
"pending_approval": () => finalPagesT("final-pages:pending_approval_92950a"),
"needs_setup": () => finalPagesT("final-pages:needs_setup_a2989b"),
"low": () => finalPagesT("final-pages:low_6c1ff0"),
"medium": () => finalPagesT("final-pages:medium_c08245"),
"high": () => finalPagesT("final-pages:high_6ef7c9"),
"critical": () => finalPagesT("final-pages:critical_bfba70"),
"secret": () => finalPagesT("final-pages:secret_2bb80d"),
"variable": () => finalPagesT("final-pages:variable_3b3251"),
"optional": () => finalPagesT("final-pages:optional_ec91fd"),
"required": () => finalPagesT("final-pages:required_d0a363"),
"new": () => finalPagesT("final-pages:new_11507a"),
"syncing": () => finalPagesT("final-pages:syncing_837d59"),
"available": () => finalPagesT("final-pages:available_ddd981"),
"warming": () => finalPagesT("final-pages:warming_da065c"),
"ok": () => finalPagesT("final-pages:ok_268936"),
"warning": () => finalPagesT("final-pages:warning_4bd935"),
"approved": () => finalPagesT("final-pages:approved_2687f8"),
"denied": () => finalPagesT("final-pages:denied_62d6c2")
};
const PAGE_VALUE_WORD_LABELS: Record<string, () => string> = {
"needs_reauthorization": () => finalPagesT("final-pages:needs_reauthorization_c85b8f"),
"require_approval": () => finalPagesT("final-pages:require_approval_ba46f2"),
"rate_limit": () => finalPagesT("final-pages:rate_limit_a0f3a1"),
"in_progress": () => finalPagesT("final-pages:in_progress_2b6b85"),
"in_review": () => finalPagesT("final-pages:in_review_009f3d"),
"pending_approval": () => finalPagesT("final-pages:pending_approval_70af19"),
"needs_setup": () => finalPagesT("final-pages:needs_setup_dd7065")
};
export function getPageValueLabel(value: string, words = false): string {
  const labels = words && Object.hasOwn(PAGE_VALUE_WORD_LABELS, value) ? PAGE_VALUE_WORD_LABELS : PAGE_VALUE_LABELS;
  return Object.hasOwn(labels, value) ? labels[value]() : value;
}
