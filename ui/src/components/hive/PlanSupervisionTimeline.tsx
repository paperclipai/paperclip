import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { plansApi, type SupervisionNote } from "../../api/plans";
import { queryKeys } from "../../lib/queryKeys";
import { timeAgo } from "../../lib/timeAgo";
import { useToastActions } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const SEVERITY_BADGE: Record<SupervisionNote["severity"], string> = {
  info: "bg-muted text-muted-foreground",
  warning: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  critical: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

const KIND_LABEL: Record<SupervisionNote["kind"], string> = {
  observation: "Observation",
  overrun: "ETA Overrun",
  action: "Action",
};

interface PlanSupervisionTimelineProps {
  planIssueId: string;
  planState: string;
}

export function PlanSupervisionTimeline({ planIssueId, planState }: PlanSupervisionTimelineProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.hive.planSupervision(planIssueId),
    queryFn: () => plansApi.supervisionNotes(planIssueId),
  });

  const monitorNow = useMutation({
    mutationFn: () => plansApi.monitorNow(planIssueId),
    onSuccess: (r) => {
      pushToast({
        title: r.woken ? "CTO woken for monitoring" : "No CTO agent found",
        tone: r.woken ? "success" : "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.hive.planSupervision(planIssueId) });
    },
    onError: (e) => pushToast({ title: "Could not trigger monitoring", body: errMsg(e), tone: "error" }),
  });

  const notes = data?.notes ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          CTO Supervision
        </h3>
        {planState === "active" && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => monitorNow.mutate()}
            disabled={monitorNow.isPending}
          >
            {monitorNow.isPending ? "Waking…" : "Monitor now"}
          </Button>
        )}
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}

      {!isLoading && notes.length === 0 && (
        <p className="text-xs text-muted-foreground">No supervision notes yet.</p>
      )}

      <div className="space-y-2">
        {notes.map((note) => (
          <SupervisionNoteCard key={note.id} note={note} />
        ))}
      </div>
    </div>
  );
}

function SupervisionNoteCard({ note }: { note: SupervisionNote }) {
  return (
    <div className="rounded-md border border-border p-2.5 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_BADGE[note.severity]}`}
        >
          {note.severity}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {KIND_LABEL[note.kind]}
        </span>
        {note.actionTaken && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {note.actionTaken}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {timeAgo(note.createdAt)}
        </span>
      </div>
      <p className="text-xs text-foreground whitespace-pre-wrap">{note.body}</p>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
