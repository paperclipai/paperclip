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
import { useTranslation } from "@/i18n";

/** Risk classification badge for a catalog tool. */
export function RiskBadge({ risk }: { risk: ToolRiskLevel | null | undefined }) {
  const { t } = useTranslation();
  if (!risk) return <Badge variant="outline">{t("tools.shared.risk.unknown", { defaultValue: "unknown" })}</Badge>;
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
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap gap-1">
      {isReadOnly ? <Badge variant="outline">{t("tools.shared.capabilities.readOnly", { defaultValue: "read-only" })}</Badge> : null}
      {isWrite ? <Badge variant="secondary">{t("tools.shared.capabilities.write", { defaultValue: "write" })}</Badge> : null}
      {isDestructive ? <Badge variant="destructive">{t("tools.shared.capabilities.destructive", { defaultValue: "destructive" })}</Badge> : null}
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
      return { key: "allowed", label: "allowed" };
    case "deny":
    case "denied":
      return { key: "denied", label: "denied" };
    case "block":
      return { key: "block", label: "block" };
    case "require_approval":
    case "requires_approval":
      return { key: "require-approval", label: "require approval" };
    case "redact":
    case "redacted":
      return { key: "redacted", label: "redacted" };
    case "rate_limited":
      return { key: "rate-limit", label: "rate limited" };
    case "defer":
    case "deferred":
      return { key: "deferred", label: "deferred" };
    case "hidden":
      return { key: "hidden", label: "hidden" };
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
  const { t } = useTranslation();
  if (!value) return <span className="text-muted-foreground">{t("tools.shared.never", { defaultValue: "never" })}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span className="text-muted-foreground">—</span>;
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const isFuture = diffMs < 0;
  let text: string;
  if (mins < 1) text = t("tools.shared.justNow", { defaultValue: "just now" });
  else {
    const val =
      mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
    text = isFuture
      ? t("tools.shared.inTime", { value: val, defaultValue: `in ${val}` })
      : t("tools.shared.timeAgo", { value: val, defaultValue: `${val} ago` });
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
  const { t } = useTranslation();
  const displayLabel = label ?? t("tools.shared.loading", { defaultValue: "Loading…" });
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      {displayLabel}
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
  const { t } = useTranslation();
  return (
    <QueryErrorState
      error={error}
      action={action ?? t("tools.shared.loadToolsAndAccess", { defaultValue: "load Tools & Access" })}
      onRetry={onRetry}
      size="panel"
    />
  );
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
  const { t } = useTranslation();
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col gap-2 py-8">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {title}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{body}</p>
        {issue ? (
          <a href={issue.href} className="text-sm font-medium text-primary hover:underline">
            {t("tools.shared.trackedIn", { identifier: issue.identifier, defaultValue: `Tracked in ${issue.identifier} →` })}
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}
