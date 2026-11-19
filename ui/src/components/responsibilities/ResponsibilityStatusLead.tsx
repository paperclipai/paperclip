import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RESPONSIBILITY_STATUS_REPORT_LABEL,
  type Agent,
  type ResponsibilityHealth,
  type ResponsibilityRollup,
  type ResponsibilityStatusReportState,
  type ResponsibilityStatusReportStatus,
} from "@paperclipai/shared";
import { Loader2, MessageSquare } from "lucide-react";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { describeReadingAge } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";
import { ResponsibilityHealthBadge, StaleFlag } from "./ResponsibilityHealthBadge";

const REPORT_HEALTH: Record<ResponsibilityStatusReportStatus, ResponsibilityHealth> = {
  behind: "behind",
  at_risk: "at_risk",
  on_track: "on_track",
  unknown: "not_measured",
};

/**
 * The agent-written status of a responsibility (the status-report module's
 * read, shared with the Dashboard). A failed or missing read is simply no
 * status: the card stays as it was.
 */
export function useResponsibilityStatusReport(responsibilityId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.responsibilities.statusReport(responsibilityId),
    queryFn: () => responsibilitiesApi.statusReport(responsibilityId),
    enabled,
    staleTime: 30_000,
  });
}

/** "Written by Ada · 3 days ago", "Written by you · today". */
export function describeStatusAuthor(
  current: NonNullable<ResponsibilityStatusReportState["current"]>,
  agentsById: ReadonlyMap<string, Agent>,
  now: Date,
  ownerUserId: string,
): string {
  const who = current.agentId
    ? agentsById.get(current.agentId)?.name ?? "an agent"
    : current.userId
      ? current.userId === ownerUserId ? "the owner" : "a teammate"
      : "an agent no longer here";
  return `Written by ${who} · ${describeReadingAge(current.writtenAt, now)}`;
}

/**
 * The bar card's status: the agent's written status as the lead line when it
 * exists (status, its one line, who wrote it and when, marked when out of
 * date, and asking the agent for an update), with the status derived from
 * the number beneath as the fact it is. Without a written status, the
 * derived status alone, as before.
 */
export function ResponsibilityStatusBlock({
  responsibility,
  agentsById,
  now,
  editable,
  className,
}: {
  responsibility: { id: string; ownerUserId: string; status: string; rollup: Pick<ResponsibilityRollup, "health" | "healthOverridden" | "statusSentence"> };
  agentsById: ReadonlyMap<string, Agent>;
  now: Date;
  /** Whether the person can ask for an update. */
  editable: boolean;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const report = useResponsibilityStatusReport(responsibility.id, responsibility.status === "active");
  const ask = useMutation({
    mutationFn: () => responsibilitiesApi.requestStatusUpdate(responsibility.id),
    onSuccess: (state) => queryClient.setQueryData(queryKeys.responsibilities.statusReport(responsibility.id), state),
  });
  const { rollup } = responsibility;
  const derived = (
    <>
      <div>
        <ResponsibilityHealthBadge health={rollup.health} overridden={rollup.healthOverridden} />
      </div>
      <p className="text-sm text-foreground" data-status-sentence="">{rollup.statusSentence}</p>
    </>
  );
  const current = report.data?.current ?? null;
  if (!current) return <div className={cn("flex flex-col gap-1.5", className)}>{derived}</div>;

  const reporterId = report.data?.reporterAgentId ?? current.agentId;
  const reporterName = reporterId ? agentsById.get(reporterId)?.name ?? "the agent" : null;
  const requested = report.data?.updateRequested ?? false;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1.5" data-agent-status="">
        <div className="flex flex-wrap items-center gap-2">
          <ResponsibilityHealthBadge health={REPORT_HEALTH[current.status]} label={RESPONSIBILITY_STATUS_REPORT_LABEL[current.status]} />
        </div>
        <p className="text-sm text-foreground" data-agent-status-message="">{current.message}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{describeStatusAuthor(current, agentsById, now, responsibility.ownerUserId)}</span>
          {current.outOfDate ? <StaleFlag label="Out of date" /> : null}
        </p>
        {editable && reporterName ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="w-fit text-muted-foreground"
              disabled={requested || ask.isPending}
              onClick={() => ask.mutate()}
              data-ask-for-update=""
            >
              {ask.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <MessageSquare aria-hidden="true" />}
              {requested ? `Asked ${reporterName} for an update` : `Ask ${reporterName} for an update`}
            </Button>
            {ask.error ? (
              <p role="alert" className="text-xs text-destructive">Couldn’t ask. {describeError(ask.error).body}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-derived-status="">
        <span className="text-xs text-muted-foreground">From the number</span>
        {derived}
      </div>
    </div>
  );
}
