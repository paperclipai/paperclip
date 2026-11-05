import { useTranslation , t } from "@/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { RadioCardGroup } from "@/components/ui/radio-card";

export function EmailConnectionAccess({
  companyId,
  connectionId,
  agents,
}: {
  companyId: string;
  connectionId: string;
  agents: Agent[];
}) {
  const { t } = useTranslation("connections");
  const cache = useQueryClient();
  const grants = useQuery({
    queryKey: queryKeys.tools.connectionGrants(connectionId),
    queryFn: () => toolsApi.listConnectionGrants(connectionId),
  });
  const installs = useQuery({
    queryKey: queryKeys.tools.connectionInstalls(connectionId),
    queryFn: () => toolsApi.getConnectionInstalls(connectionId),
  });
  const save = useMutation({
    mutationFn: (
      next: Array<{ targetType: "company" | "agent"; targetId: string }>,
    ) => toolsApi.putConnectionInstalls(connectionId, next),
    onSuccess: () => {
      void cache.invalidateQueries({
        queryKey: queryKeys.tools.connectionInstalls(connectionId),
      });
    },
  });
  const grantsView = useQueryView(grants);
  const installsView = useQueryView(installs);
  const failedView = [grantsView, installsView].find((view) => view.kind === "error");
  if (failedView)
    return (
      <QueryErrorState
        error={failedView.error}
        action="load connection access"
        onRetry={failedView.retry}
        retrying={failedView.isFetching}
      />
    );
  if (grants.isLoading || installs.isLoading || grantsView.kind === "reconnecting" || installsView.kind === "reconnecting")
    return <p className="text-sm text-muted-foreground">{t("loading_access_d4fbca4")}</p>;
  const active = grants.data?.grants.filter((g) => g.status === "active") ?? [];
  const everyone = active.some((g) => g.kind === "organization");
  const personal = active.find((g) => g.kind === "user");
  const humanLabel = everyone
    ? t("any_human_in_the_organization_7a46f7b")
    : personal
      ? personal.subjectUserId === grants.data?.currentUserId
        ? t("just_me_3f23874")
        : t("only_the_credential_owner_6f8c6fa")
      : t("access_revoked_7d420ec");
  const allAgents =
    installs.data?.installs.some((i) => i.targetType === "company") ?? false;
  const selected = new Set(
    installs.data?.installs
      .filter((i) => i.targetType === "agent")
      .map((i) => i.targetId),
  );
  const disabled = !grants.data?.capabilities.canConfigure || save.isPending;
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("which_humans_can_use_this_credential_33cb39a")}</h2>
        <p className="text-sm">{humanLabel}</p>
      </section>
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">{t("which_agents_can_use_this_connection_a13d480")}</h2>
        <RadioCardGroup
          ariaLabel={t("which_agents_can_use_this_connection_d56d22d")}
          value={allAgents ? "all" : "selected"}
          disabled={disabled}
          className="sm:grid-cols-2"
          options={[
            { value: "selected", get title() { return t("final-components-b:EmailConnectionAccess.Just_agents_I_pick_d2b7ad"); } },
            { value: "all", get title() { return t("final-components-b:EmailConnectionAccess.Any_agent_ee3e76"); } },
          ]}
          onValueChange={(value) =>
            save.mutate(
              value === "all"
                ? [{ targetType: "company", targetId: companyId }]
                : Array.from(selected, (targetId) => ({
                    targetType: "agent",
                    targetId,
                  })),
            )
          }
        />
        {!allAgents && (
          <AgentMultiSelect
            agents={agents.filter((a) => a.status !== "terminated")}
            selectedAgentIds={selected}
            disabled={disabled}
            onSave={(ids) =>
              save.mutate(
                Array.from(ids, (targetId) => ({
                  targetType: "agent",
                  targetId,
                })),
              )
            }
          />
        )}
        <p className="text-xs text-muted-foreground">{t("removing_an_assigned_agent_stops_receiving_and_e8deeb6")}</p>
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {describeError(save.error).body}
          </p>
        )}
      </section>
    </div>
  );
}
