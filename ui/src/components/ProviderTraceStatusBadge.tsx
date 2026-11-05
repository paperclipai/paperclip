import { t, useTranslation } from "@/i18n";
import type { ProviderTraceMetadata } from "@paperclipai/shared";
import { Bug, CircleOff } from "lucide-react";
import { cn } from "@/lib/utils";

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
  useTranslation("task-components");
  const status = trace?.status;
  const expired = trace
    ? new Date(trace.expiresAt).getTime() <= Date.now()
    : false;
  const label = expired
    ? t("final-components-a:traceExpired_c208aa1a")
    : status === "capturing"
      ? t("final-components-a:rawTracingEnabled_812a3547")
      : status === "complete"
        ? t("final-components-a:traceCaptured_c5a0a578")
        : status === "incomplete"
          ? t("final-components-a:traceIncomplete_329116c8")
          : status === "truncated"
            ? t("final-components-a:traceTruncated_0efe370c")
            : status === "expired"
              ? t("final-components-a:traceExpired_c208aa1a")
              : status === "deleted"
                ? t("final-components-a:traceDeleted_ce1e0dd2")
                : requested
                  ? t("final-components-a:traceRequested_f1ebbe0e")
                  : showOff
                    ? t("final-components-a:traceOff_56a98a22")
                    : null;
  if (!label) return null;
  const warning =
    status === "incomplete" ||
    status === "truncated" ||
    status === "expired" ||
    status === "deleted" ||
    expired;
  const Icon = label === t("final-components-a:traceOff_56a98a22") ? CircleOff : Bug;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
        label === t("final-components-a:traceOff_56a98a22") || label === t("final-components-a:traceDeleted_ce1e0dd2") || label === t("final-components-a:traceExpired_c208aa1a")
          ? "border-border bg-background text-muted-foreground"
          : warning
            ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
        className,
      )}
      title={
        trace
          ? t("task-components:framesBytesExpires_cf0ce36e", { value1: trace.frameCount, value2: trace.byteCount, value3: new Date(trace.expiresAt).toLocaleString() })
          : requested
            ? t("task-components:thisRunRequestedSensitiveProviderFrameCapture_4398e38a")
            : t("task-components:rawProviderFrameCaptureWasDisabledFor_90c06cbc")
      }
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
