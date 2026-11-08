import { t as translateShell, useTranslation } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork, Loader2, Users } from "lucide-react";
import type {
  CompanySkillDetail,
  CompanySkillForkPrecheckResult,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { companySkillsApi } from "@/api/companySkills";
import { queryKeys } from "@/lib/queryKeys";
import { skillStudioRoute } from "@/lib/company-skill-routes";
import { useOptionalToastActions } from "@/context/ToastContext";
import {
  agentUsageSentence,
  pickReusableFork,
  reassignTargetIds,
} from "@/lib/skill-fork";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";

/**
 * "Edit a copy" confirm dialog for read-only external skills (PAP-13112,
 * plan §3.1 / §3.2). Forks the skill through the existing fork endpoint and —
 * critically (P3, Dotta: "important! definitely need to show this to the
 * user") — surfaces how many agents run the original and offers a default-ON
 * switch to move them to the copy. When an un-diverged copy by the current
 * actor already exists, it offers to open that instead of minting another
 * (fork-sprawl guard, §5).
 */
export function ForkSkillDialog({
  companyId,
  skill,
  open,
  onOpenChange,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t: translateShell } = useTranslation("shell");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [reassign, setReassign] = useState(true);

  // Seed from the already-loaded skill detail so the dialog renders instantly,
  // then let the dedicated precheck endpoint refresh usage/existing-fork data.
  const seededPrecheck: CompanySkillForkPrecheckResult = useMemo(
    () => ({
      skillId: skill.id,
      original: {
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        sourceRef: skill.sourceRef,
      },
      agentUsageCount: skill.attachedAgentCount,
      usedByAgents: skill.usedByAgents,
      existingForks: skill.existingForks,
    }),
    [skill, translateShell],
  );

  const precheckQuery = useQuery({
    queryKey: queryKeys.companySkills.forkPrecheck(companyId, skill.id),
    queryFn: () => companySkillsApi.forkPrecheck(companyId, skill.id),
    enabled: open && Boolean(companyId && skill.id),
    initialData: seededPrecheck,
  });

  const precheck = precheckQuery.data ?? seededPrecheck;
  const usedByAgents = precheck.usedByAgents;
  const agentCount = precheck.agentUsageCount;
  const reusableFork = useMemo(
    () => pickReusableFork(precheck.existingForks),
    [precheck.existingForks, translateShell],
  );

  // Reset the toggle each time the dialog opens (default ON per §3.2).
  useEffect(() => {
    if (open) setReassign(true);
  }, [open]);

  const forkMutation = useMutation({
    mutationFn: () =>
      companySkillsApi.fork(companyId, skill.id, {
        reassignAgentIds: reassign ? reassignTargetIds(usedByAgents) : [],
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skill.id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      for (const entry of result.reassignments) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.skills(entry.agentId),
        });
      }
      const switched = result.reassignments.length;
      toast?.pushToast({
        tone: "success",
        title: translateShell("shell:editing_a_copy"),
        body:
          switched > 0
            ? translateShell("shell:skill_copy_switched", { skillName: skill.name, count: switched })
            : translateShell("shell:created_a_copy_of_it_s_now", { value1: skill.name }),
      });
      onOpenChange(false);
      navigate(skillStudioRoute(result.skill.id));
    },
    onError: (error) => {
      toast?.pushToast({
        tone: "error",
        title: translateShell("shell:couldn_t_create_a_copy"),
        body: error instanceof Error ? error.message : translateShell("shell:the_fork_request_failed"),
      });
    },
  });

  const busy = forkMutation.isPending;
  const forkLabel =
    reassign && agentCount > 0
      ? translateShell("shell:skill_copy_switch_count", { count: agentCount })
      : translateShell("shell:create_copy");

  const openExisting = () => {
    if (!reusableFork) return;
    onOpenChange(false);
    navigate(skillStudioRoute(reusableFork.id));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitFork className="h-4 w-4" />{translateShell("shell:edit_a_copy_of")}{" "}{skill.name}
          </DialogTitle>
          <DialogDescription>{translateShell("shell:is_read_only_because_it_comes_from", { value1: skill.name })}</DialogDescription>
        </DialogHeader>

        {reusableFork ? (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
            <p className="font-medium text-foreground">{translateShell("shell:you_already_have_a_copy")}</p>
            <p className="mt-0.5 text-muted-foreground">{translateShell("shell:an_unedited_copy_of_this_skill_already")}</p>
            <Button
              type="button"
              size="sm"
              className="mt-2"
              onClick={openExisting}
              disabled={busy}
            >{translateShell("shell:open_your_existing_copy")}</Button>
          </div>
        ) : null}

        {/* P3 — unmissable agent-switch block (plan §3.2), not fine print. */}
        <div
          className={cn(
            "rounded-md border p-3",
            agentCount > 0 ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/30",
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="h-4 w-4 shrink-0" />
            <span>{agentUsageSentence(agentCount)}</span>
          </div>

          {agentCount > 0 ? (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {usedByAgents.map((agent) => (
                  <span
                    key={agent.id}
                    className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground"
                  >
                    {agent.name}
                  </span>
                ))}
              </div>
              <label className="mt-3 flex items-start justify-between gap-3">
                <span className="text-sm">
                  <span className="font-medium text-foreground">{translateShell("shell:switch_these_agents_to_the_copy")}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {reassign
                      ? translateShell("shell:these_agents_will_run_your_copy_instead")
                      : translateShell("shell:these_agents_keep_running_the_original_your")}
                  </span>
                </span>
                <ToggleSwitch
                  checked={reassign}
                  onCheckedChange={setReassign}
                  disabled={busy}
                  aria-label={translateShell("shell:switch_these_agents_to_the_copy")}
                />
              </label>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">{translateShell("shell:nothing_is_assigned_to_it_so_your")}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >{translateShell("shell:cancel")}</Button>
          <Button
            type="button"
            variant={reusableFork ? "outline" : "default"}
            onClick={() => forkMutation.mutate()}
            disabled={busy}
          >
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {reusableFork ? translateShell("shell:create_another_copy") : forkLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
