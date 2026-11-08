import { useTranslation } from "@/i18n";
import { useState } from "react";
import { Crown, Loader2 } from "lucide-react";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AI_PROVIDERS } from "./model";

export function AiDefaultCrown({ account }: { account: Pick<AiManagedConnectionSummary, "provider"> }) {
  const { t } = useTranslation("connections");
  const [open, setOpen] = useState(false);
  const label = t("your_default_for_provider", { provider: AI_PROVIDERS[account.provider].name });
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild>
      <button type="button" aria-label={label} className="shrink-0 rounded-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={event => { event.preventDefault(); setOpen(true); }}>
        <Crown className="size-4" aria-hidden="true" />
      </button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>;
}

export function AiDefaultMenuItem({ account, pending, onSelect }: {
  account: AiManagedConnectionSummary; pending: boolean; onSelect: () => void;
}) {
  const { t } = useTranslation("connections");
  const provider = AI_PROVIDERS[account.provider].name;
  const reason = account.unavailableReason ?? (account.status !== "connected" ? t("reconnect_before_default") : null);
  return <DropdownMenuItem disabled={account.isDefault || pending || Boolean(reason)} onSelect={onSelect}>
    {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Crown aria-hidden="true" />}
    <span className="flex min-w-0 flex-col gap-1">
      <span>{account.isDefault ? t("default_for_provider", { provider }) : t("set_default_for_provider", { provider })}</span>
      {!account.isDefault && reason && <span className="text-xs text-muted-foreground">{reason}</span>}
    </span>
  </DropdownMenuItem>;
}

export function AiDefaultError({ provider, pending, onRetry }: {
  provider: string; pending: boolean; onRetry: () => void;
}) {
  const { t } = useTranslation("connections");
  return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
    <p>{t("change_default_failed", { provider })}</p>
    <Button variant="outline" size="sm" disabled={pending} onClick={onRetry}>{t("retry_49618ff")}</Button>
  </div>;
}
