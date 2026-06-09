import { useMemo } from "react";
import { Activity as ActivityIcon, Play } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "../../lib/timeAgo";
import { EmptyState } from "../EmptyState";
import { LiveRunWidget } from "../LiveRunWidget";
import { RoutineHistoryTab } from "../RoutineHistoryTab";
import { RoutineActivityRow } from "../RoutineActivityRow";
import { useRoutineDetail } from "./context";

export function RunsSection() {
  const ctx = useRoutineDetail();
  const { routine, routineRuns, hasLiveRun, activeIssueId, onOpenRunDialog } = ctx;
  const runs = routineRuns ?? [];

  return (
    <div className="space-y-4">
      {hasLiveRun && activeIssueId ? (
        <LiveRunWidget issueId={activeIssueId} companyId={routine.companyId} />
      ) : null}
      {runs.length === 0 ? (
        <EmptyState
          icon={Play}
          message="No runs yet. Trigger a run from the header or wait for the schedule."
          action="Run now"
          onAction={onOpenRunDialog}
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {runs.map((run) => (
            <div key={run.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="shrink-0">
                  {run.source}
                </Badge>
                <Badge
                  variant={run.status === "failed" ? "destructive" : "secondary"}
                  className="shrink-0"
                >
                  {run.status.replaceAll("_", " ")}
                </Badge>
                {run.trigger ? (
                  <span className="truncate text-muted-foreground">
                    {run.trigger.label ?? run.trigger.kind}
                  </span>
                ) : null}
                {run.linkedIssue ? (
                  <Link
                    to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`}
                    className="truncate text-muted-foreground hover:underline"
                  >
                    {run.linkedIssue.identifier ?? run.linkedIssue.id.slice(0, 8)}
                  </Link>
                ) : null}
              </div>
              <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                {timeAgo(run.triggeredAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ActivitySection() {
  const ctx = useRoutineDetail();
  const { activity } = ctx;
  const events = activity ?? [];

  const groups = useMemo(() => {
    const byDay = new Map<string, typeof events>();
    for (const event of events) {
      let label = "Earlier";
      try {
        label = new Date(event.createdAt).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      } catch {
        /* keep fallback label */
      }
      const bucket = byDay.get(label) ?? [];
      bucket.push(event);
      byDay.set(label, bucket);
    }
    return Array.from(byDay.entries());
  }, [events]);

  if (events.length === 0) {
    return <EmptyState icon={ActivityIcon} message="No activity yet." />;
  }

  return (
    <div className="space-y-4">
      {groups.map(([day, dayEvents]) => (
        <div key={day}>
          <div className="sticky top-0 bg-background py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {day}
          </div>
          <div>
            {dayEvents.map((event) => (
              <RoutineActivityRow key={event.id} event={event} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistorySection() {
  const ctx = useRoutineDetail();
  const {
    routine,
    isEditDirty,
    dirtyFields,
    routineDefaults,
    setEditDraft,
    saveRoutine,
    agentById,
    projectById,
    availableSecrets,
    onHistoryRestoreSecretMaterials,
    onHistoryRestored,
  } = ctx;

  return (
    <RoutineHistoryTab
      routine={routine}
      isEditDirty={isEditDirty}
      dirtyFields={dirtyFields}
      onDiscardEdits={() => setEditDraft(routineDefaults)}
      onSaveEdits={() => {
        if (!saveRoutine.isPending && routine.title.trim()) {
          saveRoutine.mutate();
        }
      }}
      agents={agentById}
      projects={projectById}
      secrets={availableSecrets}
      onRestoreSecretMaterials={onHistoryRestoreSecretMaterials}
      onRestored={onHistoryRestored}
    />
  );
}
