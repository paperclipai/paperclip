import { useTranslation } from "@/i18n";
import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ToolMcpGatewayWithTokens, ToolRedactedValueSummary } from "@paperclipai/shared";
import { toolsApi, type ToolAuditOutcome, type ToolGatewayActivityEvent } from "@/api/tools";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { queryKeys } from "@/lib/queryKeys";
import { RelativeTime } from "@/pages/tools/shared";

const PAGE_SIZE = 25;

const OUTCOME_META: Record<ToolAuditOutcome, { status: string }> = {
  allowed: { status: "allowed" },
  blocked: { status: "denied" },
  asked_first: { status: "require-approval" },
  waiting: { status: "deferred" },
  failed: { status: "failed" },
  unknown: { status: "unchecked" },
};

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formatSummary(summary: ToolRedactedValueSummary | null | undefined): string | null {
  if (!summary?.summary) return null;
  try {
    return JSON.stringify(JSON.parse(summary.summary), null, 2);
  } catch {
    return summary.summary;
  }
}

function summaryFromDetails(
  details: Record<string, unknown> | null,
  key: "argumentsSummary" | "resultSummary",
): ToolRedactedValueSummary | null {
  const value = details?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = (value as Record<string, unknown>).summary;
  return typeof summary === "string" ? { summary } : null;
}

function durationLabel(event: ToolGatewayActivityEvent): string | null {
  const started = event.invocation?.startedAt ? new Date(event.invocation.startedAt).getTime() : Number.NaN;
  const completed = event.invocation?.completedAt ? new Date(event.invocation.completedAt).getTime() : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return `${completed - started} ms`;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={mono ? "min-w-0 break-all font-mono text-(length:--text-micro) text-foreground" : "min-w-0 text-foreground"}>
        {value}
      </dd>
    </div>
  );
}

function ActivityRow({ event }: { event: ToolGatewayActivityEvent }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const outcome = OUTCOME_META[event.normalizedOutcome] ?? OUTCOME_META.unknown;
  const outcomeLabels: Record<ToolAuditOutcome, string> = {
    allowed: t("apps.GatewayActivityPanel.outcomeAllowed"),
    blocked: t("apps.GatewayActivityPanel.outcomeBlocked"),
    asked_first: t("apps.GatewayActivityPanel.outcomeAskedFirst"),
    waiting: t("apps.GatewayActivityPanel.outcomeWaiting"),
    failed: t("apps.GatewayActivityPanel.outcomeFailed"),
    unknown: t("apps.GatewayActivityPanel.outcomeUnknown"),
  };
  const actor = event.agentDisplayName ?? t("apps.GatewayActivityPanel.fallbackClient");
  const app = event.appDisplayName ?? event.connectionDisplayName ?? event.applicationDisplayName ?? t("apps.GatewayActivityPanel.fallbackApp");
  const tool = event.toolDisplayName ?? event.invocation?.toolName ?? t("apps.GatewayActivityPanel.fallbackTool");
  const rawTool = event.invocation?.toolName ?? detailString(event.details, "tool") ?? detailString(event.details, "toolName");
  const reason = detailString(event.details, "reasonCode");
  const argumentsText = formatSummary(
    event.invocation?.argumentsSummary ?? summaryFromDetails(event.details, "argumentsSummary"),
  );
  const resultText = formatSummary(
    event.invocation?.resultSummary ?? summaryFromDetails(event.details, "resultSummary"),
  );
  const duration = durationLabel(event);

  return (
    <li className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-accent/50"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-foreground">
            <span className="font-medium">{actor}</span> {t("apps.GatewayActivityPanel.usedVerb")} <span className="font-medium">{tool}</span> {t("apps.GatewayActivityPanel.inPreposition")} {app}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <StatusBadge status={outcome.status} label={outcomeLabels[event.normalizedOutcome] ?? outcomeLabels.unknown} />
          <span className="text-xs text-muted-foreground">
            · <RelativeTime value={event.createdAt} />
          </span>
        </span>
      </button>

      {open ? (
        <div className="border-t border-border bg-muted/30 px-4 py-3 pl-10 text-xs">
          <dl>
            {rawTool ? <Fact label={t("apps.GatewayActivityPanel.factTool")} value={rawTool} mono /> : null}
            {event.invocation?.status ? <Fact label={t("apps.GatewayActivityPanel.factCallStatus")} value={event.invocation.status} /> : null}
            {event.invocation?.policyDecision ? <Fact label={t("apps.GatewayActivityPanel.factDecision")} value={event.invocation.policyDecision} /> : null}
            {reason ? <Fact label={t("apps.GatewayActivityPanel.factReason")} value={reason} mono /> : null}
            {duration ? <Fact label={t("apps.GatewayActivityPanel.factDuration")} value={duration} /> : null}
            {event.invocation?.id ? <Fact label={t("apps.GatewayActivityPanel.factInvocationId")} value={event.invocation.id} mono /> : null}
            {event.invocation?.errorCode ? <Fact label={t("apps.GatewayActivityPanel.factErrorCode")} value={event.invocation.errorCode} mono /> : null}
            {event.invocation?.errorMessage ? <Fact label={t("apps.GatewayActivityPanel.factError")} value={event.invocation.errorMessage} /> : null}
          </dl>
          {argumentsText ? (
            <div className="mt-2 space-y-1">
              <div className="text-muted-foreground">{t("apps.GatewayActivityPanel.argumentsRedacted")}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
                {argumentsText}
              </pre>
            </div>
          ) : null}
          {resultText ? (
            <div className="mt-3 space-y-1">
              <div className="text-muted-foreground">{t("apps.GatewayActivityPanel.resultRedacted")}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
                {resultText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function GatewayActivityPanel({
  companyId,
  gateway,
}: {
  companyId: string;
  gateway: ToolMcpGatewayWithTokens;
}) {
  const { t } = useTranslation();
  const activityQuery = useInfiniteQuery({
    queryKey: queryKeys.tools.activity(companyId, { gateway: gateway.id, window: "30d" }),
    queryFn: ({ pageParam }) =>
      toolsApi.listActivity(companyId, {
        gateway: gateway.id,
        window: "30d",
        limit: PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const activityView = useQueryView(activityQuery);

  const events = useMemo(
    () => activityQuery.data?.pages.flatMap((page) => page.events) ?? [],
    [activityQuery.data],
  );

  if (activityQuery.isLoading || activityView.kind === "reconnecting") {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (activityView.kind === "error") {
    return (
      <QueryErrorState
        error={activityQuery.error}
        action={t("errorActions.loadGatewayActivity")}
        onRetry={activityView.retry}
        retrying={activityView.isFetching}
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("apps.GatewayActivityPanel.description")}
      </p>
      {events.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t("apps.GatewayActivityPanel.noCalls")}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {events.map((event) => <ActivityRow key={event.id} event={event} />)}
        </ul>
      )}
      {activityQuery.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => activityQuery.fetchNextPage()}
            disabled={activityQuery.isFetchingNextPage}
          >
            {activityQuery.isFetchingNextPage ? t("apps.GatewayActivityPanel.loading") : t("apps.GatewayActivityPanel.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
