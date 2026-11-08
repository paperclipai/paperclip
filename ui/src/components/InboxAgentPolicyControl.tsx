import { t, useTranslation } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, LoaderCircle, Save } from "lucide-react";
import type { InboxAgentPolicy, InboxAgentPolicyMode } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { inboxAgentPolicyApi } from "@/api/inbox-agent-policy";
import { queryKeys } from "@/lib/queryKeys";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { isAgentTaskTarget } from "@/lib/company-members";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { Button } from "@/components/ui/button";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";

const MODE_OPTIONS: RadioCardOption[] = [
  {
    value: "open",
    get title() { return t("task-components:anyOfMyAgents_4146a13b"); },
    get description() { return t("task-components:letAnyAgentYouManageArchiveTasks_d2820c83"); },
  },
  {
    value: "allowlist",
    get title() { return t("task-components:onlyChosenAgents_ff0b72dd"); },
    get description() { return t("task-components:restrictInboxTidyingToTheAgentsYou_ea27e1b1"); },
  },
  {
    value: "disabled",
    get title() { return t("task-components:off_ca7981b4"); },
    get description() { return t("task-components:agentsCanNeverArchiveTasksFromYour_7d3cc88c"); },
  },
];

function policyKey(mode: InboxAgentPolicyMode, allowedAgentIds: string[]): string {
  return `${mode}:${[...allowedAgentIds].sort().join(",")}`;
}

interface Draft {
  mode: InboxAgentPolicyMode;
  allowedAgentIds: string[];
}

/**
 * "Let agents tidy my inbox" user-settings control. A single
 * three-state policy — `open` / `allowlist` / `disabled` — round-tripped through
 * the per-user endpoints. When `allowlist` is selected the user picks which
 * of their agents may archive. The one-click Undo/Unarchive affordance and the
 * "Archived by …" attribution live elsewhere (inbox rows / properties pane).
 */
export function InboxAgentPolicyControl({ companyId }: { companyId: string | null | undefined }) {
  useTranslation("task-components");
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const lastServerKeyRef = useRef<string | null>(null);

  const policyQuery = useQuery({
    queryKey: companyId ? queryKeys.inboxAgentPolicy.mine(companyId) : ["inbox-agent-policy", "none"],
    queryFn: () => inboxAgentPolicyApi.getMine(companyId!),
    enabled: !!companyId,
  });
  const policyView = useQueryView(policyQuery);
  const policy = policyQuery.data;

  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const selectableAgents = useMemo(
    () => (agentsQuery.data ?? []).filter(isAgentTaskTarget),
    [agentsQuery.data],
  );
  const agentOptions = useMemo(
    () => selectableAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title ?? agent.role,
      icon: agent.icon,
    })),
    [selectableAgents],
  );
  const selectedAgentIds = useMemo(
    () => new Set(draft?.allowedAgentIds ?? []),
    [draft?.allowedAgentIds],
  );

  // Adopt server state on first load, or on refetch when the user has not
  // diverged from the previously-synced snapshot (so a background refetch never
  // clobbers pending edits).
  useEffect(() => {
    if (!policy) return;
    const serverKey = policyKey(policy.mode, policy.allowedAgentIds);
    setDraft((current) => {
      if (current === null || policyKey(current.mode, current.allowedAgentIds) === lastServerKeyRef.current) {
        return { mode: policy.mode, allowedAgentIds: policy.allowedAgentIds };
      }
      return current;
    });
    lastServerKeyRef.current = serverKey;
  }, [policy]);

  const updateMutation = useMutation({
    mutationFn: (next: Draft) =>
      inboxAgentPolicyApi.updateMine(companyId!, {
        mode: next.mode,
        allowedAgentIds: next.mode === "allowlist" ? next.allowedAgentIds : [],
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData<InboxAgentPolicy>(queryKeys.inboxAgentPolicy.mine(companyId!), saved);
    },
  });

  const isDirty = Boolean(
    draft && policy && policyKey(draft.mode, draft.allowedAgentIds) !== policyKey(policy.mode, policy.allowedAgentIds),
  );

  // A saved policy stays on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the control.
  if (policyView.kind === "error") {
    return (
      <QueryErrorState
        error={policyView.error}
        action="load the inbox agent policy"
        onRetry={policyView.retry}
        retrying={policyView.isFetching}
      />
    );
  }

  if (policyQuery.isLoading || policyView.kind === "reconnecting" || !draft) {
    return <div className="text-sm text-muted-foreground">{t("task-components:loadingInboxAgentPolicy_c6c02848")}</div>;
  }

  return (
    <section className="space-y-4" aria-label={t("task-components:letAgentsTidyMyInbox_e2e2d36a")}>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t("task-components:letAgentsTidyMyInbox_e2e2d36a")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("task-components:chooseWhetherTheAgentsYouManageMay_998e091d")}</p>
      </div>

      <RadioCardGroup
        ariaLabel={t("final-components-a:inboxAgentArchivingPolicy_9dba8922")}
        value={draft.mode}
        onValueChange={(value) => setDraft((current) => (current ? { ...current, mode: value as InboxAgentPolicyMode } : current))}
        options={MODE_OPTIONS}
        className="max-w-2xl"
      />

      {draft.mode === "allowlist" ? (
        <div className="max-w-2xl space-y-2">
          <div className="text-sm font-medium">{t("task-components:agentsAllowedToTidyMyInbox_d849f31d")}</div>
          <AgentMultiSelect
            agents={agentOptions}
            selectedAgentIds={selectedAgentIds}
            onChange={(next) =>
              setDraft((current) =>
                current ? { ...current, allowedAgentIds: [...next] } : current,
              )
            }
            triggerLabel={
              selectedAgentIds.size === 0
                ? t("final-components-a:selectAgents_9c2f5e9f")
                : t("final-components-a:agentsSelected", { count: selectedAgentIds.size })
            }
            triggerFullWidth={false}
            showSelectionPreview={false}
            emptyMessage={t("task-components:youDonTManageAnyAgentsYet_7816c363")}
          />
        </div>
      ) : null}

      {updateMutation.error ? (
        <div role="alert" className="max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {describeError(updateMutation.error, { action: "save the inbox agent policy" }).body}
        </div>
      ) : null}

      <div className="flex max-w-2xl items-center justify-end gap-3">
        {updateMutation.isSuccess && !isDirty ? (
          <span className="text-xs text-muted-foreground" role="status">{t("task-components:saved_b5c120b3")}</span>
        ) : null}
        <Button
          type="button"
          disabled={!isDirty || updateMutation.isPending}
          onClick={() => draft && updateMutation.mutate(draft)}
        >
          {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          {updateMutation.isPending ? t("task-components:saving_23e39291") : t("task-components:save_1509f561")}
        </Button>
      </div>
    </section>
  );
}
