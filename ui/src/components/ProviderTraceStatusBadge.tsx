import { useTranslation } from "@/i18n";
import type { ProviderTraceMetadata } from "@paperclipai/shared";
import { Bug, CircleOff } from "lucide-react";
import { cn } from "@/lib/utils";

const TRACE_LABEL_KEYS: Record<string, string> = {
  "Trace expired": "localizationCommonTail.traceExpired",
  "Raw tracing enabled": "localizationCommonTail.traceEnabled",
  "Trace captured": "localizationCommonTail.traceCaptured",
  "Trace incomplete": "localizationCommonTail.traceIncomplete",
  "Trace truncated": "localizationCommonTail.traceTruncated",
  "Trace deleted": "localizationCommonTail.traceDeleted",
  "Trace requested": "localizationCommonTail.traceRequested",
  "Trace off": "localizationCommonTail.traceOff",
};

export function runRequestedProviderTrace(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (!contextSnapshot) return false;
  const debug = contextSnapshot.debug;
  return (
    typeof debug === "object" &&
    debug !== null &&
    !Array.isArray(debug) &&
    (debug as Record<string, unknown>).providerTrace === "raw"
  );
}

export function ProviderTraceStatusBadge({
  trace,
  requested = false,
  showOff = false,
  className,
}: {
  trace?: ProviderTraceMetadata | null;
  requested?: boolean;
  showOff?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const status = trace?.status;
  const expired = trace
    ? new Date(trace.expiresAt).getTime() <= Date.now()
    : false;
  const label = expired
    ? "Trace expired"
    : status === "capturing"
      ? "Raw tracing enabled"
      : status === "complete"
        ? "Trace captured"
        : status === "incomplete"
          ? "Trace incomplete"
          : status === "truncated"
            ? "Trace truncated"
            : status === "expired"
              ? "Trace expired"
              : status === "deleted"
                ? "Trace deleted"
                : requested
                  ? "Trace requested"
                  : showOff
                    ? "Trace off"
                    : null;
  if (!label) return null;
  const warning =
    status === "incomplete" ||
    status === "truncated" ||
    status === "expired" ||
    status === "deleted" ||
    expired;
  const Icon = label === "Trace off" ? CircleOff : Bug;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
        label === "Trace off" || label === "Trace deleted" || label === "Trace expired"
          ? "border-border bg-background text-muted-foreground"
          : warning
            ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
        className,
      )}
      title={
        trace
          ? t("localizationCommonTail.traceSummary", { frames: trace.frameCount, bytes: trace.byteCount, expires: new Date(trace.expiresAt).toLocaleString(i18n.language) })
          : requested
            ? t("localizationCommonTail.sensitiveTraceRequested")
            : t("localizationCommonTail.traceDisabled")
      }
    >
      <Icon className="h-3 w-3" />
      {t(TRACE_LABEL_KEYS[label])}
    </span>
  );
}
