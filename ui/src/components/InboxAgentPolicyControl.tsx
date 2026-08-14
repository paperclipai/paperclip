import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, LoaderCircle, Save } from "lucide-react";
import type { InboxAgentPolicy, InboxAgentPolicyMode } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { inboxAgentPolicyApi } from "@/api/inbox-agent-policy";
import { queryKeys } from "@/lib/queryKeys";
import { isAgentTaskTarget } from "@/lib/company-members";
import { AgentIcon } from "./AgentIconPicker";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";
import { t } from "@/i18n";

const MODE_OPTIONS: RadioCardOption[] = [
  {
    value: "open",
    title: t("inboxPolicy.anyAgents"),
    description: t("inboxPolicy.anyAgentsDesc"),
  },
  {
    value: "allowlist",
    title: t("inboxPolicy.chosenAgents"),
    description: t("inboxPolicy.chosenAgentsDesc"),
  },
  {
    value: "disabled",
    title: t("inboxPolicy.off"),
    description: t("inboxPolicy.offDesc"),
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
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const lastServerKeyRef = useRef<string | null>(null);

  const policyQuery = useQuery({
    queryKey: companyId ? queryKeys.inboxAgentPolicy.mine(companyId) : ["inbox-agent-policy", "none"],
    queryFn: () => inboxAgentPolicyApi.getMine(companyId!),
    enabled: !!companyId,
  });
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

  if (policyQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {policyQuery.error instanceof Error ? policyQuery.error.message : t("inboxPolicy.failedLoad")}
      </div>
    );
  }

  if (policyQuery.isLoading || !draft) {
    return <div className="text-sm text-muted-foreground">{t("inboxPolicy.loading")}</div>;
  }

  const toggleAgent = (agentId: string, checked: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const set = new Set(current.allowedAgentIds);
      if (checked) set.add(agentId);
      else set.delete(agentId);
      return { ...current, allowedAgentIds: [...set] };
    });
  };

  return (
    <section className="space-y-4" aria-label={t("inboxPolicy.title")}>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t("inboxPolicy.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("inboxPolicy.description")}
        </p>
      </div>

      <RadioCardGroup
        ariaLabel={t("inboxPolicy.ariaLabel")}
        value={draft.mode}
        onValueChange={(value) => setDraft((current) => (current ? { ...current, mode: value as InboxAgentPolicyMode } : current))}
        options={MODE_OPTIONS}
        className="max-w-2xl"
      />

      {draft.mode === "allowlist" ? (
        <div className="max-w-2xl space-y-2 rounded-md border border-border p-3">
          <div className="text-sm font-medium">{t("inboxPolicy.allowedAgents")}</div>
          {selectableAgents.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("inboxPolicy.noAgents")}</p>
          ) : (
            <ul className="space-y-1.5">
              {selectableAgents.map((agent) => {
                const checked = draft.allowedAgentIds.includes(agent.id);
                return (
                  <li key={agent.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent/40">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => toggleAgent(agent.id, next === true)}
                        aria-label={t("inboxPolicy.allowAgent", { name: agent.name })}
                      />
                      <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate text-sm">{agent.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{agent.role}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {updateMutation.error ? (
        <div className="max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {updateMutation.error instanceof Error ? updateMutation.error.message : t("inboxPolicy.failedSave")}
        </div>
      ) : null}

      <div className="flex max-w-2xl items-center justify-end gap-3">
        {updateMutation.isSuccess && !isDirty ? (
          <span className="text-xs text-muted-foreground" role="status">{t("inboxPolicy.saved")}</span>
        ) : null}
        <Button
          type="button"
          disabled={!isDirty || updateMutation.isPending}
          onClick={() => draft && updateMutation.mutate(draft)}
        >
          {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          {updateMutation.isPending ? t("inboxPolicy.saving") : t("inboxPolicy.save")}
        </Button>
      </div>
    </section>
  );
}
