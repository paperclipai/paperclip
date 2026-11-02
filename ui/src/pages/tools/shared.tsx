import { t, useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import type {
  ToolRiskLevel,
  ToolConnectionHealthStatus,
  ToolPolicyDecision,
} from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/StatusBadge";
import { ApiError } from "@/api/client";

export function toolRiskLabel(value: string): string {
  switch (value) {
    case "low": return t("localizationTools.toolRiskLabel_low");
    case "medium": return t("localizationTools.toolRiskLabel_medium");
    case "high": return t("localizationTools.toolRiskLabel_high");
    case "critical": return t("localizationTools.toolRiskLabel_critical");
    case "read": return t("localizationTools.toolRiskLabel_read");
    case "write": return t("localizationTools.toolRiskLabel_write");
    case "destructive": return t("localizationTools.toolRiskLabel_destructive");
    default: return value;
  }
}

export function toolHealthLabel(value: string): string {
  switch (value) {
    case "running": return t("localizationTools.toolHealthLabel_running");
    case "stopped": return t("localizationTools.toolHealthLabel_stopped");
    case "active": return t("localizationTools.toolHealthLabel_active");
    case "disabled": return t("localizationTools.toolHealthLabel_disabled");
    case "archived": return t("localizationTools.toolHealthLabel_archived");
    case "green": return t("localizationTools.toolHealthLabel_green");
    case "amber": return t("localizationTools.toolHealthLabel_amber");
    case "red": return t("localizationTools.toolHealthLabel_red");
    case "healthy": return t("localizationTools.toolHealthLabel_healthy");
    case "ok": return t("localizationTools.toolHealthLabel_ok");
    case "degraded": return t("localizationTools.toolHealthLabel_degraded");
    case "warning": return t("localizationTools.toolHealthLabel_warning");
    case "error": return t("localizationTools.toolHealthLabel_error");
    case "unhealthy": return t("localizationTools.toolHealthLabel_unhealthy");
    case "critical": return t("localizationTools.toolHealthLabel_critical");
    case "unchecked": return t("localizationTools.toolHealthLabel_unchecked");
    case "unknown": return t("localizationTools.toolHealthLabel_unknown");
    case "not run": return t("localizationTools.toolHealthLabel_not_run");
    case "not running": return t("localizationTools.toolHealthLabel_not_running");
    case "pass": return t("localizationTools.toolHealthLabel_pass");
    case "fail": return t("localizationTools.toolHealthLabel_fail");
    case "skipped": return t("localizationTools.toolHealthLabel_skipped");
    default: return value;
  }
}

export function toolEntityLabel(value: string): string {
  switch (value) {
    case "allow": return t("localizationTools.toolEntity_allow");
    case "deny": return t("localizationTools.toolEntity_deny");
    case "include": return t("localizationTools.toolEntity_include");
    case "exclude": return t("localizationTools.toolEntity_exclude");
    case "application": return t("localizationTools.toolEntity_application");
    case "connection": return t("localizationTools.toolEntity_connection");
    case "catalog_entry": return t("localizationTools.toolEntity_catalog_entry");
    case "tool_name": return t("localizationTools.toolEntity_tool_name");
    case "risk_level": return t("localizationTools.toolEntity_risk_level");
    case "company": return t("localizationTools.toolEntity_company");
    case "project": return t("localizationTools.toolEntity_project");
    case "routine": return t("localizationTools.toolEntity_routine");
    case "agent": return t("localizationTools.toolEntity_agent");
    case "issue": return t("localizationTools.toolEntity_issue");
    case "board_user": return t("localizationTools.toolEntity_board_user");
    case "user": return t("localizationTools.toolEntity_user");
    case "system": return t("localizationTools.toolEntity_system");
    default: return value;
  }
}

/** Risk classification badge for a catalog tool. */
export function RiskBadge({ risk }: { risk: ToolRiskLevel | null | undefined }) {
  const { t } = useTranslation();
  if (!risk) return <Badge variant="outline">{t("pages.notFound.unknown")}</Badge>;
  const variant =
    risk === "high" || risk === "critical"
      ? "destructive"
      : risk === "medium"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{toolRiskLabel(risk)}</Badge>;
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
      {isReadOnly ? <Badge variant="outline">{t("localizationTools.readOnly578")}</Badge> : null}
      {isWrite ? <Badge variant="secondary">{t("localizationTools.write579")}</Badge> : null}
      {isDestructive ? <Badge variant={"destructive"}>{t("localizationTools.destructive580")}</Badge> : null}
    </span>
  );
}

/** Catalog quarantine marker — canonical status key. */
export function QuarantineBadge() {
  useTranslation();
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
  useTranslation();
  const raw = (status ?? "unknown").toString();
  return <StatusBadge status={healthToStatusKey(raw)} label={label ?? toolHealthLabel(raw)} />;
}

function decisionToStatusKey(decision: string): { key: string; label: string } {
  switch (decision) {
    case "allow":
    case "allowed":
      return { key: "allowed", label: t("localizationTools.decision_allowed") };
    case "deny":
    case "denied":
      return { key: "denied", label: t("localizationTools.decision_denied") };
    case "block":
      return { key: "block", label: t("localizationTools.decision_block") };
    case "require_approval":
    case "requires_approval":
      return { key: "require-approval", label: t("localizationTools.requireApproval581") };
    case "redact":
    case "redacted":
      return { key: "redacted", label: t("localizationTools.decision_redacted") };
    case "rate_limited":
      return { key: "rate-limit", label: t("localizationTools.rateLimited582") };
    case "defer":
    case "deferred":
      return { key: "deferred", label: t("localizationTools.decision_deferred") };
    case "hidden":
      return { key: "hidden", label: t("localizationTools.decision_hidden") };
    default:
      return { key: decision, label: decision };
  }
}

/** Policy/gateway decision badge — canonical status colors. */
export function DecisionBadge({ decision }: { decision: ToolPolicyDecision | string | null | undefined }) {
  useTranslation();
  if (!decision) return <Badge variant="outline">—</Badge>;
  const { key, label } = decisionToStatusKey(decision.toString());
  return <StatusBadge status={key} label={label} />;
}

/** Compact relative time, falling back to absolute. */
export function RelativeTime({ value }: { value: Date | string | null | undefined }) {
  const { t, i18n } = useTranslation();
  if (!value) return <span className="text-muted-foreground">{t("pages.instanceSettings.never")}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span className="text-muted-foreground">—</span>;
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const isFuture = diffMs < 0;
  let text: string;
  if (mins < 1) text = t("common.formatting.justNow");
  else {
    const value =
      mins < 60 ? t("localizationTools.compactMinutes", { count: mins }) : mins < 1440 ? t("localizationTools.compactHours", { count: Math.round(mins / 60) }) : t("localizationTools.compactDays", { count: Math.round(mins / 1440) });
    text = isFuture ? t("localizationTools.relativeFuture", { value }) : t("localizationTools.relativePast", { value });
  }
  return (
    <span title={date.toLocaleString(i18n.resolvedLanguage)} className="text-muted-foreground">
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
  useTranslation();
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

export function LoadingState({ label = t("pages.secrets.status.loading") }: { label?: string }) {
  useTranslation();
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      {label}
    </div>
  );
}

/** Actionable error surface — surfaces the server message and HTTP status. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  let message: string;
  if (error instanceof ApiError) {
    if (error.status === 403) {
      message = t("localizationTools.youDoNotHavePermissionToViewThisToolsAccessRe588");
    } else if (error.status === 404 || /route not found/i.test(error.message)) {
      // Snapshot-skew window: the route exists in this build but not on the live server snapshot yet.
      message = t("localizationTools.toolsAccessIsnTAvailableOnThisServerYetTryRef589");
    } else {
      message = error.message;
    }
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = t("localizationTools.somethingWentWrong590");
  }
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex flex-col gap-3 py-6">
        <div className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">{t("localizationTools.couldNotLoadThisView591")}</p>
            <p className="text-destructive/80">{message}</p>
          </div>
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="self-start rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
          >{t("pages.inbox.retry")}</button>
        ) : null}
      </CardContent>
    </Card>
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
            {t("localizationTools.trackedIn", { identifier: issue.identifier })}
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}
