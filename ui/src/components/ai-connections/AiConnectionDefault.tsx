import { useState } from "react";
import { Crown, Loader2 } from "lucide-react";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AI_PROVIDERS } from "./model";

export function AiDefaultCrown({ account }: { account: Pick<AiManagedConnectionSummary, "provider"> }) {
  const [open, setOpen] = useState(false);
  const label = `Your default for ${AI_PROVIDERS[account.provider].name}`;
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
  const provider = AI_PROVIDERS[account.provider].name;
  const reason = account.unavailableReason ?? (account.status !== "connected" ? "Reconnect this account before making it your default." : null);
  return <DropdownMenuItem disabled={account.isDefault || pending || Boolean(reason)} onSelect={onSelect}>
    {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Crown aria-hidden="true" />}
    <span className="flex min-w-0 flex-col gap-1">
      <span>{account.isDefault ? `Default for ${provider}` : `Set as default for ${provider}`}</span>
      {!account.isDefault && reason && <span className="text-xs text-muted-foreground">{reason}</span>}
    </span>
  </DropdownMenuItem>;
}

export function AiDefaultError({ provider, pending, onRetry }: {
  provider: string; pending: boolean; onRetry: () => void;
}) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
    <p>Couldn’t change your {provider} default.</p>
    <Button variant="outline" size="sm" disabled={pending} onClick={onRetry}>Retry</Button>
  </div>;
}
