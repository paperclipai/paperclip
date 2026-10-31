import { createContext, useContext, useRef, useState } from "react";
import { ArrowRight, Crown } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Shared presentation for the application and the approved review stories. */
export interface PrimaryAgentPresentation {
  companyId: string;
  primaryAgentId: string | null;
  primaryAgent: Agent | null;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  pendingAgentId?: string | null;
  onChange: (agentId: string) => void;
}

const PrimaryAgentContext = createContext<PrimaryAgentPresentation | null>(null);
export const PrimaryAgentPresentationProvider = PrimaryAgentContext.Provider;

export function usePrimaryAgentPresentation(companyId?: string | null) {
  const value = useContext(PrimaryAgentContext);
  return value && (!companyId || value.companyId === companyId) ? value : null;
}

export function PrimaryAgentIndicator({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const primary = usePrimaryAgentPresentation(companyId);
  if (!primary || primary.loading || primary.primaryAgentId !== agentId) return null;
  return <Tooltip>
    <TooltipTrigger asChild>
      <span role="img" aria-label="My primary agent" className="inline-flex shrink-0 text-primary">
        <Crown aria-hidden="true" className="size-3.5" />
      </span>
    </TooltipTrigger>
    <TooltipContent>My primary agent</TooltipContent>
  </Tooltip>;
}

const crownClass = "primary-crown relative";

export function PrimaryAgentCrownButton({ agent }: {
  agent: Agent;
}) {
  const primary = usePrimaryAgentPresentation(agent.companyId);
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState<Agent | null>(null);
  const [pop, setPop] = useState<"now" | "after-dialog" | null>(null);
  const filledRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (!primary || agent.status === "terminated" || agent.status === "pending_approval") return null;
  const selected = primary.primaryAgentId === agent.id;
  const previous = primary.primaryAgent?.id === primary.primaryAgentId ? primary.primaryAgent : null;
  const loading = primary.loading || Boolean(primary.primaryAgentId && !previous);
  const busy = loading || Boolean(primary.pendingAgentId);
  const choose = (timing: "now" | "after-dialog") => {
    setPop(timing);
    primary.onChange(agent.id);
  };
  const request = () => {
    if (!previous) return choose("now");
    setReplacing(previous);
    setConfirming(true);
  };

  const control = primary.error ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Retry loading primary agent" onClick={primary.onRetry}
          className={cn(crownClass, "text-destructive")}>
          <Crown aria-hidden="true" className="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Couldn't load your primary agent. Select to retry.</TooltipContent>
    </Tooltip>
  ) : selected && !loading ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={filledRef} role="img" aria-label="My primary agent" tabIndex={-1} data-pop={pop ?? undefined}
          onAnimationEnd={(event) => { if (event.animationName === "primary-crown-ring") setPop(null); }}
          className={cn(crownClass, "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-primary outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)")}>
          <Crown aria-hidden="true" className="size-5 fill-current" />
        </span>
      </TooltipTrigger>
      <TooltipContent>My primary agent</TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button ref={buttonRef} type="button" variant="ghost" size="icon-sm" aria-label="Set as my primary" disabled={busy} onClick={request}
          className={cn(crownClass, "text-muted-foreground/50 hover:text-foreground")}>
          <Crown aria-hidden="true" className="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{loading ? "Loading your primary agent…" : "Set as my primary"}</TooltipContent>
    </Tooltip>
  );

  return <>
    {control}
    {replacing ? <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent onCloseAutoFocus={(event) => {
        event.preventDefault();
        (filledRef.current ?? buttonRef.current)?.focus();
      }}>
        <div className="flex items-start justify-center gap-5 pt-2">
          <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
            <AgentAvatar agent={replacing} size={64} label={`${replacing.name} avatar`} />
            <span className="max-w-full break-words text-sm font-medium">{replacing.name}</span>
          </div>
          <ArrowRight aria-hidden="true" className="mt-5 size-6 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
            <AgentAvatar agent={agent} size={64} label={`${agent.name} avatar`}
              className="rounded-xl ring-1 ring-primary ring-offset-2 ring-offset-background" />
            <span className="flex max-w-full items-center justify-center gap-1.5 text-sm font-medium">
              <span className="min-w-0 break-words">{agent.name}</span>
              <span role="img" aria-label="New primary agent" className="inline-flex shrink-0 text-primary">
                <Crown aria-hidden="true" className="size-3.5" />
              </span>
            </span>
          </div>
        </div>
        <AlertDialogHeader>
          <AlertDialogTitle>Change your primary agent?</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            This will make {agent.name} your primary agent, do you want to do this?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row justify-between sm:justify-between">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => choose("after-dialog")}>Set as my primary</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog> : null}
  </>;
}
