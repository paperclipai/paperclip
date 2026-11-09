import { useState } from "react";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { AiProviderSetup } from "../ai-connections/AiProviderSetup";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { useTranslation } from "@/i18n";

export function OnboardingGatewaySetup({
  companyId,
  agentId,
  environmentId,
  adapterType,
  disabled,
  className,
  onComplete,
}: {
  companyId: string;
  agentId?: string;
  environmentId?: string;
  adapterType: "codex_local" | "claude_local";
  disabled?: boolean;
  className?: string;
  onComplete: (binding: Exclude<AiConnectionBinding, { mode: "responsible_user" }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  return <>
    <Button type="button" variant="ghost" className={className} disabled={disabled} onClick={() => setOpen(true)}>
      {t("onboarding.gatewaySetup.trigger")}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onKeyDown={event => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t("onboarding.gatewaySetup.title")}</DialogTitle>
          <DialogDescription>{t("onboarding.gatewaySetup.description")}</DialogDescription>
        </DialogHeader>
        <AiProviderSetup companyId={companyId} agentId={agentId} environmentId={environmentId}
          initialProvider="gateway" initialProtocol={adapterType === "codex_local" ? "responses" : "messages"}
          submitLabel={t("onboarding.gatewaySetup.submitLabel")} onCancel={() => setOpen(false)}
          onComplete={binding => { setOpen(false); onComplete(binding); }} />
      </DialogContent>
    </Dialog>
  </>;
}
