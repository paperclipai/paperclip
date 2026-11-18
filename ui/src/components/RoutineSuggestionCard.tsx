import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Repeat } from "lucide-react";
import type { SuggestRoutineInteraction } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { routineSuggestionsApi } from "@/api/routine-suggestions";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

const DEFAULT_OFFER = "This looks like something that comes up regularly. Want me to do it on a schedule?";

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The agent's offer, after it finishes a task, to repeat that task as a
 * routine. Shown inline in the task conversation right after the completion
 * message, not above the composer: it is an optional follow-up, not an input
 * the agent waits on. Declined and withdrawn offers leave no card.
 */
export function RoutineSuggestionCard({ interaction }: { interaction: SuggestRoutineInteraction }) {
  const queryClient = useQueryClient();
  const { payload, result } = interaction;
  const agentId = interaction.createdByAgentId ?? payload.assigneeAgentId;
  const agentQuery = useQuery({
    queryKey: [...queryKeys.agents.detail(agentId), interaction.companyId],
    queryFn: () => agentsApi.get(agentId, interaction.companyId),
    enabled: interaction.status === "pending",
    staleTime: 60_000,
  });

  const settle = async (updated: SuggestRoutineInteraction) => {
    queryClient.setQueriesData<SuggestRoutineInteraction[]>(
      { queryKey: ["issues", "interactions"] },
      (current) => current?.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    );
    // Task routes key interaction caches by UUID or identifier; prefix
    // invalidation reaches whichever one is mounted.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      queryClient.invalidateQueries({ queryKey: ["routines"] }),
    ]);
  };
  const accept = useMutation({
    mutationFn: () => routineSuggestionsApi.accept(interaction.issueId, interaction.id, localTimeZone()),
    onSuccess: (response) => settle(response.interaction),
  });
  const decline = useMutation({
    mutationFn: () => routineSuggestionsApi.decline(interaction.issueId, interaction.id),
    onSuccess: (updated) => settle(updated),
  });

  if (interaction.status === "accepted") {
    return (
      <div id={`interaction-${interaction.id}`} data-testid="routine-suggestion-accepted"
        className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Repeat aria-hidden className="h-4 w-4 shrink-0" />
        {result?.routineId ? (
          <span className="min-w-0">
            Routine set up:{" "}
            <Link to={`/routines/${result.routineId}`} className="font-medium text-foreground underline-offset-4 hover:underline">
              {result.routineTitle ?? payload.title}
            </Link>
            {" "}· {result.cadenceLabel ?? payload.cadenceLabel}
          </span>
        ) : (
          <span>Setting up the routine…</span>
        )}
      </div>
    );
  }
  if (interaction.status !== "pending") return null;

  const agentName = agentQuery.data?.name ?? "Your agent";
  const busy = accept.isPending || decline.isPending;
  const error = accept.error ?? decline.error;
  return (
    <article id={`interaction-${interaction.id}`} data-testid="routine-suggestion"
      aria-label={`Offer to repeat ${payload.title}`}
      className="rounded-md border border-border bg-card/60 px-3 py-3">
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agentQuery.data ?? undefined} name={agentName} size={24} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium text-foreground">{agentName}</p>
          <p className="text-sm text-foreground">{payload.message ?? DEFAULT_OFFER}</p>
          <div className="flex min-w-0 items-start gap-2 text-sm">
            <Repeat aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="font-medium text-foreground">{payload.title}</p>
              <p className="text-muted-foreground">{payload.cadenceLabel}</p>
            </div>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">{describeError(error).body}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => decline.mutate()}>
              No thanks
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => accept.mutate()}>
              {accept.isPending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Repeat aria-hidden className="h-4 w-4" />}
              Make it a routine
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}
