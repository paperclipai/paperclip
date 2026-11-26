import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { routinesApi } from "@/api/routines";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { RoutineActivityRow } from "@/components/RoutineActivityRow";
import { queryKeys } from "@/lib/queryKeys";

export function RoutineAuditActivity({
  companyId,
  routineId,
}: {
  companyId: string;
  routineId: string;
}) {
  const activity = useQuery({
    queryKey: [...queryKeys.routines.activity(companyId, routineId), "audit"],
    queryFn: async () => {
      const [routine, runs] = await Promise.all([
        routinesApi.get(routineId),
        routinesApi.listRuns(routineId, 200),
      ]);
      return routinesApi.activity(companyId, routineId, {
        triggerIds: routine.triggers.map((trigger) => trigger.id),
        runIds: runs.map((run) => run.id),
      });
    },
  });
  const activityView = useQueryView(activity);

  // A loaded feed stays on screen through a failed refetch; an outage before
  // the first load reads as loading, and only a real failure shows copy.
  if (activityView.kind === "loading" || activityView.kind === "reconnecting") {
    return (
      <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
        Loading routine activity…
      </div>
    );
  }

  if (activityView.kind === "error") {
    return (
      <QueryErrorState
        error={activityView.error}
        action="load routine activity"
        onRetry={activityView.retry}
        retrying={activityView.isFetching}
      />
    );
  }

  const events = activityView.data ?? [];
  if (events.length === 0) {
    return <EmptyState icon={Activity} message="No routine activity yet." />;
  }

  return (
    <div className="border-y border-border" aria-label="Routine activity">
      {events.map((event) => (
        <RoutineActivityRow key={event.id} event={event} />
      ))}
    </div>
  );
}
