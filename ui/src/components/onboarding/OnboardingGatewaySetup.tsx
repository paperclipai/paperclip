import { useTranslation , t } from "@/i18n";
import { useState } from "react";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { AiProviderSetup } from "../ai-connections/AiProviderSetup";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

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
  const { t } = useTranslation("connections");
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" variant="ghost" className={className} disabled={disabled} onClick={() => setOpen(true)}>{t("use_a_custom_gateway_c6d19f7")}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onKeyDown={event => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t("custom_gateway_connection_c9c9e9d")}</DialogTitle>
          <DialogDescription>{t("save_the_connection_then_choose_a_model_d1906d0")}</DialogDescription>
        </DialogHeader>
        <AiProviderSetup companyId={companyId} agentId={agentId} environmentId={environmentId}
          initialProvider="gateway" initialProtocol={adapterType === "codex_local" ? "responses" : "messages"}
          submitLabel={t("final-components-b:onboarding.OnboardingGatewaySetup.Save_connection_df24ef")} onCancel={() => setOpen(false)}
          onComplete={binding => { setOpen(false); onComplete(binding); }} />
      </DialogContent>
    </Dialog>
  </>;
}
