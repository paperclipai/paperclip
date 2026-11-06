import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save, UserRoundCheck } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { userDelegateApi, type UserDelegateState } from "@/api/user-delegate";
import { queryKeys } from "@/lib/queryKeys";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { isAgentTaskTarget } from "@/lib/company-members";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";

const NONE = "";

/**
 * "My delegate" user-settings control. The person names at most one agent that
 * may act as them on the listed person-only actions, or turns it off. Every
 * delegate action is logged with the agent and its reason before it runs.
 */
export function UserDelegateControl({ companyId }: { companyId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const delegateQuery = useQuery({
    queryKey: companyId ? queryKeys.userDelegate.mine(companyId) : ["user-delegate", "none"],
    queryFn: () => userDelegateApi.getMine(companyId!),
    enabled: !!companyId,
  });
  const delegateView = useQueryView(delegateQuery);
  const savedAgentId = delegateQuery.data?.delegate?.delegateAgentId ?? NONE;

  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const selectableAgents = useMemo(
    () => (agentsQuery.data ?? []).filter(isAgentTaskTarget),
    [agentsQuery.data],
  );

  useEffect(() => {
    if (delegateQuery.data) setDraft(savedAgentId);
  }, [delegateQuery.data, savedAgentId]);

  const saveMutation = useMutation({
    mutationFn: (agentId: string) =>
      agentId === NONE
        ? userDelegateApi.clearMine(companyId!)
        : userDelegateApi.setMine(companyId!, { agentId }),
    onSuccess: (saved) => {
      queryClient.setQueryData<UserDelegateState>(queryKeys.userDelegate.mine(companyId!), saved);
    },
  });

  if (delegateView.kind === "error") {
    return (
      <QueryErrorState
        error={delegateView.error}
        action="load your delegate"
        onRetry={delegateView.retry}
        retrying={delegateView.isFetching}
      />
    );
  }

  if (delegateQuery.isLoading || delegateView.kind === "reconnecting" || draft === null) {
    return <div className="text-sm text-muted-foreground">Loading your delegate…</div>;
  }

  const isDirty = draft !== savedAgentId;
  const actions = delegateQuery.data?.actions ?? [];

  return (
    <section className="space-y-4" aria-label="My delegate">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <UserRoundCheck className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">My delegate</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Choose one agent that may act as you on the actions below. It must give a reason each time, and
          every action is logged with the agent, you and the reason. Choose &quot;Off&quot; to stop it at once.
        </p>
      </div>

      <div className="max-w-2xl space-y-2">
        <label htmlFor="user-delegate-agent" className="text-sm font-medium">Delegate agent</label>
        <NativeSelect
          id="user-delegate-agent"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        >
          <option value={NONE}>Off</option>
          {selectableAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </NativeSelect>
      </div>

      {actions.length > 0 ? (
        <details className="max-w-2xl text-sm">
          <summary className="cursor-pointer text-muted-foreground">What a delegate can do</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {actions.map((action) => (
              <li key={action.key}>{action.description}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {saveMutation.error ? (
        <div role="alert" className="max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {describeError(saveMutation.error, { action: "save your delegate" }).body}
        </div>
      ) : null}

      <div className="flex max-w-2xl items-center justify-end gap-3">
        {saveMutation.isSuccess && !isDirty ? (
          <span className="text-xs text-muted-foreground" role="status">Saved</span>
        ) : null}
        <Button
          type="button"
          disabled={!isDirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate(draft)}
        >
          {saveMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          {saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
