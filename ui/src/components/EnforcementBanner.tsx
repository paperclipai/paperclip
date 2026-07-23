import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { cva, type VariantProps } from "class-variance-authority";
import { ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";

/**
 * Persistent enforcement-state banner for the Tools & Access surface (PAP-10389).
 *
 * Two modes:
 *
 * 1. **Data-driven** (default) — pass only `companyId`. Renders the standing
 *    "enforcement is server-side" message and tints to `denied-detected` when
 *    governed tool calls were denied or failed in the last hour. This is an
 *    *observability* banner — enforcement itself lives in the tool gateway.
 *
 * 2. **Presentational** (`tone` + `title`/`body`) — a static governance banner
 *    used to surface a fixed message such as the PAP-10400 trust-tier copy on
 *    the Runtime tab. Tones map to the same OKLCH token palette used elsewhere:
 *    `info` (neutral/shield), `warning` (amber), `error` (destructive).
 */
const enforcementBanner = cva(
  "flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm",
  {
    variants: {
      variant: {
        default: "border-border bg-muted/40 text-muted-foreground",
        "denied-detected":
          "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
        info: "border-border bg-muted/40 text-muted-foreground",
        warning:
          "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
        error:
          "border-destructive/40 bg-destructive/5 text-destructive dark:text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const DENY_ACTIONS = new Set(["tool_gateway.call_denied", "tool_gateway.call_failed"]);
const ONE_HOUR_MS = 60 * 60 * 1000;

export type EnforcementTone = "info" | "warning" | "error";

export interface EnforcementBannerProps extends VariantProps<typeof enforcementBanner> {
  companyId?: string;
  className?: string;
  /** Override the computed variant (used by the design guide). */
  forceVariant?: "default" | "denied-detected";
  recentDenialCount?: number;
  /**
   * Presentational mode: when provided, the banner renders a static governance
   * message with this tone instead of the data-driven denial summary.
   */
  tone?: EnforcementTone;
  /** Presentational title (bold first line). */
  title?: ReactNode;
  /** Presentational body copy. */
  body?: ReactNode;
  /** Override the leading icon (presentational mode). */
  icon?: LucideIcon;
  /** Optional trailing action node (presentational mode). */
  action?: ReactNode;
}

function PresentationalBanner({
  tone,
  title,
  body,
  icon,
  action,
  className,
}: {
  tone: EnforcementTone;
  title?: ReactNode;
  body?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = icon ?? (tone === "info" ? ShieldCheck : ShieldAlert);
  const iconTone =
    tone === "info"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-destructive";
  return (
    <div className={cn(enforcementBanner({ variant: tone }), className)} role="status">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconTone)} />
      <div className="min-w-0 flex-1 space-y-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {body ? <p className="opacity-90">{body}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EnforcementBanner(props: EnforcementBannerProps) {
  const { companyId, className, forceVariant, recentDenialCount, tone, title, body, icon, action } = props;

  // Presentational mode short-circuits the data hook below.
  const isPresentational = tone !== undefined;

  const audit = useQuery({
    queryKey: queryKeys.tools.audit(companyId ?? "", 100),
    queryFn: () => toolsApi.listAudit(companyId ?? "", 100),
    enabled:
      !isPresentational &&
      forceVariant === undefined &&
      recentDenialCount === undefined &&
      !!companyId,
    refetchInterval: 30_000,
  });

  if (isPresentational) {
    return (
      <PresentationalBanner
        tone={tone}
        title={title}
        body={body}
        icon={icon}
        action={action}
        className={className}
      />
    );
  }

  const computedCount =
    recentDenialCount ??
    (audit.data ?? []).filter((row) => {
      if (!DENY_ACTIONS.has(row.action)) return false;
      const ts = new Date(row.createdAt).getTime();
      return Number.isFinite(ts) && Date.now() - ts <= ONE_HOUR_MS;
    }).length;

  const variant: "default" | "denied-detected" =
    forceVariant ?? (computedCount > 0 ? "denied-detected" : "default");

  return (
    <div className={cn(enforcementBanner({ variant }), className)} role="status">
      {variant === "denied-detected" ? (
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      )}
      <div className="min-w-0 flex-1">
        {variant === "denied-detected" ? (
          <p>
            <span className="font-medium">{computedCount}</span> governed tool call
            {computedCount === 1 ? " was" : "s were"} denied or failed in the last hour. Access is enforced
            server-side by the tool gateway — review what was blocked and why in the audit log.
          </p>
        ) : (
          <p>
            Tool access is enforced server-side by the tool gateway. These screens configure and observe that
            enforcement — they do not replace it. Agents see and call only the tools their profiles and policies
            allow; everything else is denied by default.
          </p>
        )}
      </div>
      <Link
        to="/apps/advanced/audit"
        className="shrink-0 text-xs font-medium text-primary hover:underline"
      >
        View audit →
      </Link>
    </div>
  );
}
