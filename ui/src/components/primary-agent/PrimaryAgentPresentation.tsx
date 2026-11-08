import { useTranslation } from "@/i18n";
import { createContext, useContext, useRef, useState, type CSSProperties } from "react";
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
  const { t } = useTranslation("agent-config");
  const primary = usePrimaryAgentPresentation(companyId);
  if (!primary || primary.loading || primary.primaryAgentId !== agentId) return null;
  return <Tooltip>
    <TooltipTrigger asChild>
      <span role="img" aria-label={t("agent-config:myPrimaryAgent_6f9c4dd")} className="inline-flex shrink-0 text-primary">
        <Crown aria-hidden="true" className="size-3.5" />
      </span>
    </TooltipTrigger>
    <TooltipContent>{t("agent-config:myPrimaryAgent_6f9c4dd")}</TooltipContent>
  </Tooltip>;
}

const crownClass = "primary-crown relative";

type CrownPop = { timing: "now" | "after-dialog"; bubbles: { angle: number; size: number; travel: number }[] };

function crownBubbles(): CrownPop["bubbles"] {
  const start = Math.random() * 360;
  return [0, 1, 2].map((index) => ({
    angle: Math.round(start + index * 120 + (Math.random() - 0.5) * 60),
    size: Number((0.45 + Math.random() * 0.55).toFixed(2)),
    travel: Number((0.8 + Math.random() * 0.4).toFixed(2)),
  }));
}

export function PrimaryAgentCrownButton({ agent }: {
  agent: Agent;
}) {
  const { t } = useTranslation("agent-config");
  const primary = usePrimaryAgentPresentation(agent.companyId);
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState<Agent | null>(null);
  const [pop, setPop] = useState<CrownPop | null>(null);
  const filledRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const quietTooltip = useRef(false);
  if (!primary || agent.status === "terminated" || agent.status === "pending_approval") return null;
  const selected = primary.primaryAgentId === agent.id;
  const previous = primary.primaryAgent?.id === primary.primaryAgentId ? primary.primaryAgent : null;
  const loading = primary.loading || Boolean(primary.primaryAgentId && !previous);
  const busy = loading || Boolean(primary.pendingAgentId);
  const choose = (timing: CrownPop["timing"]) => {
    setPop({ timing, bubbles: crownBubbles() });
    primary.onChange(agent.id);
  };
  const request = () => {
    if (!previous) return choose("now");
    setReplacing(previous);
    setConfirming(true);
  };
  const tooltip = {
    open: tooltipOpen,
    onOpenChange: (open: boolean) => setTooltipOpen(open && !quietTooltip.current),
  };
  const wakeTooltip = () => { quietTooltip.current = false; };

  const control = primary.error ? (
    <Tooltip {...tooltip}>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("agent-config:retryLoadingPrimaryAgent_0c43761")} onClick={primary.onRetry}
          onPointerMove={wakeTooltip} onBlur={wakeTooltip}
          className={cn(crownClass, "text-destructive")}>
          <Crown aria-hidden="true" className="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("agent-config:couldnTLoadYourPrimaryAgentSelectTo_5f9e42d")}</TooltipContent>
    </Tooltip>
  ) : selected && !loading ? (
    <Tooltip {...tooltip}>
      <TooltipTrigger asChild>
        <span ref={filledRef} role="img" aria-label={t("agent-config:myPrimaryAgent_6f9c4dd")} tabIndex={-1} data-pop={pop?.timing}
          onPointerMove={wakeTooltip} onBlur={wakeTooltip}
          onAnimationEnd={(event) => { if (event.animationName === "primary-crown-pop") setPop(null); }}
          className={cn(crownClass, "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-primary outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)")}>
          <Crown aria-hidden="true" className="size-5 fill-current" />
          {pop?.bubbles.map((bubble, index) => (
            <span key={index} aria-hidden="true" className="primary-crown-bubble"
              style={{ "--bubble-angle": bubble.angle, "--bubble-size": bubble.size, "--bubble-travel": bubble.travel } as CSSProperties} />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("agent-config:myPrimaryAgent_6f9c4dd")}</TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip {...tooltip}>
      <TooltipTrigger asChild>
        <Button ref={buttonRef} type="button" variant="ghost" size="icon-sm" aria-label={t("agent-config:setAsMyPrimary_3ed404c")} disabled={busy} onClick={request}
          onPointerMove={wakeTooltip} onBlur={wakeTooltip}
          className={cn(crownClass, "text-muted-foreground/50 hover:text-foreground")}>
          <Crown aria-hidden="true" className="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{loading ? t("agent-config:loadingYourPrimaryAgent_9d02d52") : t("agent-config:setAsMyPrimary_3ed404c")}</TooltipContent>
    </Tooltip>
  );

  return <>
    {control}
    {replacing ? <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent onCloseAutoFocus={(event) => {
        event.preventDefault();
        quietTooltip.current = true;
        setTooltipOpen(false);
        (filledRef.current ?? buttonRef.current)?.focus();
      }}>
        <div className="flex items-start justify-center gap-5 pt-2">
          <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
            <AgentAvatar agent={replacing} size={64} label={t("agent-config:valueAvatar_2c6730a", { value1: replacing.name })} />
            <span className="max-w-full break-words text-sm font-medium">{replacing.name}</span>
          </div>
          <ArrowRight aria-hidden="true" className="mt-5 size-6 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
            <AgentAvatar agent={agent} size={64} label={t("agent-config:valueAvatar_2c6730a", { value1: agent.name })}
              className="rounded-xl ring-1 ring-primary ring-offset-2 ring-offset-background" />
            <span className="flex max-w-full items-center justify-center gap-1.5 text-sm font-medium">
              <span className="min-w-0 break-words">{agent.name}</span>
              <span role="img" aria-label={t("agent-config:newPrimaryAgent_e794a90")} className="inline-flex shrink-0 text-primary">
                <Crown aria-hidden="true" className="size-3.5" />
              </span>
            </span>
          </div>
        </div>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("agent-config:changeYourPrimaryAgent_06e23b9")}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">{t("agent-config:thisWillMake_ab7b161")} {agent.name} {t("agent-config:yourPrimaryAgentDoYouWantToDo_3a71c64")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row justify-between sm:justify-between">
          <AlertDialogCancel>{t("agent-config:cancel_77dfd21")}</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => choose("after-dialog")}>{t("agent-config:setAsMyPrimary_3ed404c")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog> : null}
  </>;
}
