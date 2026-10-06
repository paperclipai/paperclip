import { useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { copyTextToClipboard } from "@/lib/clipboard";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/** Preserve the existing agent-only invitation path beside the setup wizard. */
export function ExternalAgentInviteDialog({ companyId, onClose, onBack }: {
  companyId: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ prompt: string; copyStatus: "idle" | "copied" | "failed" } | null>(null);
  const prompt = result?.prompt;
  const createInvite = useMutation({
    mutationFn: async () => {
      const invite = await accessApi.createCompanyInvite(companyId, {
        allowedJoinTypes: "agent",
        humanRole: null,
        agentMessage: message.trim() || null,
      });
      void cache.invalidateQueries({ queryKey: queryKeys.access.invites(companyId, "all", 5) });
      const path = invite.onboardingTextUrl ?? invite.onboardingTextPath ?? `/api/invites/${invite.token}/onboarding.txt`;
      const onboardingTextUrl = new URL(path, window.location.origin).href;
      const manifest = await accessApi.getInviteOnboarding(invite.token).catch(() => null);
      return buildAgentOnboardingPrompt({
        onboardingTextUrl,
        connectionCandidates: manifest?.onboarding.connectivity?.connectionCandidates ?? null,
        testResolutionUrl: manifest?.onboarding.connectivity?.testResolutionEndpoint?.url ?? null,
      });
    },
    onSuccess: async (value) => {
      if (!mounted.current) return;
      // Keep the invitation readable while a browser clipboard request is pending.
      setResult({ prompt: value, copyStatus: "idle" });
      let copyStatus: "copied" | "failed" = "copied";
      try {
        await copyTextToClipboard(value);
      } catch {
        copyStatus = "failed";
      }
      if (mounted.current) setResult((current) => current?.copyStatus === "idle" ? { ...current, copyStatus } : current);
    },
  });
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-(--sz-calc-16) overflow-y-auto sm:max-w-2xl">
      <DialogTitle>{prompt ? t("localizationAgents.ui230_Agent_onboarding_prompt") : t("localizationAgents.ui220_Invite_an_external_agent")}</DialogTitle>
      <DialogDescription>
        {prompt ? t("agentSetup.invitePromptDescription")
          : t("agentSetup.inviteDescription")}
      </DialogDescription>
      {prompt ? <>
        <Textarea aria-label={t("localizationAgents.ui230_Agent_onboarding_prompt")} readOnly value={prompt} className="min-h-64 font-mono text-xs" />
        {result?.copyStatus === "failed" && <p role="alert" className="text-sm text-muted-foreground">{t("agentSetup.clipboardUnavailable")}</p>}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Button variant="ghost" onClick={onClose}>{t("common.done")}</Button>
          <AgentSetupPrompt
            prompt={prompt}
            label={t("oct5Core.copyOnboarding")}
            title={t("oct5Core.inviteAgent")}
            description={t("oct5Core.inviteAgentDescription")}
            initialCopyStatus={result?.copyStatus}
            onCopied={() => setResult((current) => current && { ...current, copyStatus: "copied" })}
          />
        </div>
      </> : <>
        <label className="space-y-2 text-sm">
          <span>{t("localizationAgents.ui225_Optional_message_for_the_agent")}</span>
          <Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} className="min-h-24" />
        </label>
        {createInvite.error && <p role="alert" className="text-sm text-destructive">{createInvite.error.message}</p>}
        <div className="flex justify-between gap-4">
          <Button variant="ghost" onClick={onBack}>{t("pages.secrets.actions.back")}</Button>
          <Button disabled={createInvite.isPending} onClick={() => createInvite.mutate()}>
            {createInvite.isPending ? t("localizationAgents.ui228_Generating_") : t("localizationAgents.ui229_Generate_onboarding_prompt")}
          </Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
