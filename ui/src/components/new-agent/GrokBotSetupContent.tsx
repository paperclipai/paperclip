import { useId } from "react";
import { Check, Circle, Loader2 } from "lucide-react";
import { AGENT_ROLES, type CreateGrokInvitation, type DotPairing, type GrokConnection } from "@paperclipai/shared";
import { AdapterMark } from "../AdapterMark";
import { AgentSetupPrompt } from "../AgentSetupPrompt";
import { Button, buttonVariants } from "../ui/button";
import { CopyText } from "../CopyText";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/select";
import { DialogDescription, DialogTitle } from "../ui/dialog";
import { buildGrokAccessPrompt, buildGrokRoutinePrompt } from "@/lib/grok-bot-setup-prompt";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";

export type GrokSetupStep = 0 | 1 | 2 | 3;
export interface GrokBotSetupContentProps {
  step: GrokSetupStep; companyName: string; details: CreateGrokInvitation;
  created: boolean; loading?: boolean; busy?: boolean; error?: string;
  managers: Array<{ id: string; name: string }>;
  connection?: GrokConnection; pairing: DotPairing | null; approvalHref?: string;
  webhookUrl: string; webhookKey: string; editingCredentials?: boolean;
  onEditCredentials?: () => void;
  onDetails: (details: CreateGrokInvitation) => void;
  onCredentials: (url: string, key: string) => void;
  onBack: () => void; onExit: () => void; onNext: () => void; onRetry: () => void;
}
export function GrokBotSetupContent(p: GrokBotSetupContentProps) {
  const { t } = useTranslation();
  const steps = [
    t("agents.grokBotSetupContent.stepIdentify"),
    t("agents.grokBotSetupContent.stepConnect"),
    t("agents.grokBotSetupContent.stepAssignments"),
    t("agents.grokBotSetupContent.stepVerify"),
  ];
  const pairingCodeId = useId();
  const binding = p.connection?.binding;
  const routine = binding?.routine;
  const exchange = routine?.lastExchange;
  const delivered = exchange?.status === "accepted" || exchange?.status === "acknowledged";
  const replied = !!routine?.verified && exchange?.status === "acknowledged";
  const ready = replied && p.connection?.agentLifecycleState === "ready" && !!p.connection.canConfigureConnection && !routine?.recoveryNeeded;
  const pending = exchange && ["prepared", "sending", "accepted"].includes(exchange.status) && Date.parse(exchange.expiresAt) > Date.now();
  const nextDisabled = p.busy || p.loading || !!p.approvalHref
    || p.step === 0 && (!p.details.name.trim() || !p.details.botName.trim())
    || p.step === 1 && !binding?.connected
    || p.step === 2 && ((!routine?.configured || p.editingCredentials) && (!p.webhookUrl || !p.webhookKey))
    || p.step === 3 && !ready && (!!pending || !!routine?.recoveryNeeded || !!replied);
  return <>
    <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6 pt-8 sm:px-8">
      <div className="space-y-3 pr-5">
        <AdapterMark type="grok_bot" className="size-10" />
        <DialogTitle className="text-xl font-semibold tracking-tight">{ready ? t("agents.grokBotSetupContent.connectedTitle") : t("agents.grokBotSetupContent.connectTitle")}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">{ready ? t("agents.grokBotSetupContent.connectedDescription", { botName: p.details.botName, companyName: p.companyName }) : t("agents.grokBotSetupContent.connectDescription", { companyName: p.companyName })}</DialogDescription>
      </div>
      <ol aria-label={t("agents.grokBotSetupContent.stepsLabel")} className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
        {steps.map((label, index) => <li key={label} aria-current={p.step === index ? "step" : undefined} className={p.step === index ? "font-medium text-foreground" : ""}>{index + 1}. {label}</li>)}
      </ol>
      {p.error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{p.error}</p><Button variant="outline" disabled={p.busy} onClick={p.onRetry}>{t("agents.grokBotSetupContent.tryAgain")}</Button></div>}
      {p.loading ? <p role="status" className="text-sm text-muted-foreground">{t("agents.grokBotSetupContent.restoring")}</p> : p.approvalHref ? <p className="text-sm text-muted-foreground">{t("agents.grokBotSetupContent.approvalNeeded")}</p> : <>
        {p.step === 0 && <div className="space-y-4">
          <label className="block space-y-2 text-sm"><span>{t("agents.grokBotSetupContent.paperclipName")}</span><Input value={p.details.name} disabled={p.created} onChange={e => p.onDetails({ ...p.details, name: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <label className="block space-y-2 text-sm"><span>{t("agents.grokBotSetupContent.botNameInGrok")}</span><Input value={p.details.botName} disabled={p.created} onChange={e => p.onDetails({ ...p.details, botName: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <p className="text-xs text-muted-foreground">{t("agents.grokBotSetupContent.nameHint")}</p>
          <label className="block space-y-2 text-sm"><span>{t("agents.grokBotSetupContent.role")}</span><NativeSelect disabled={p.created} value={p.details.role ?? "general"} onChange={e => p.onDetails({ ...p.details, role: e.target.value as CreateGrokInvitation["role"] })}>{AGENT_ROLES.map(role => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</NativeSelect></label>
          <label className="block space-y-2 text-sm"><span>{t("agents.grokBotSetupContent.manager")}</span><NativeSelect disabled={p.created} value={p.details.reportsTo ?? ""} onChange={e => p.onDetails({ ...p.details, reportsTo: e.target.value || null })}><option value="">{t("agents.grokBotSetupContent.noManager")}</option>{p.managers.map(manager => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</NativeSelect></label>
        </div>}
        {p.step === 1 && <div className="space-y-4 text-sm">
          <p>{t("agents.grokBotSetupContent.accessInstructions")}</p>
          {p.connection?.resourceUrl && <AgentSetupPrompt prompt={buildGrokAccessPrompt(p.connection.resourceUrl, p.details.botName)} label={t("agents.grokBotSetupContent.copyConnectionLabel")} title={t("agents.grokBotSetupContent.connectAccessTitle")} description={t("agents.grokBotSetupContent.connectAccessDescription")} />}
          {!binding?.connected && p.pairing && <div className="space-y-2">
            <label htmlFor={pairingCodeId}>{t("agents.grokBotSetupContent.pairingCodeLabel")}</label>
            <div className="flex items-center gap-2">
              <Input id={pairingCodeId} value={p.pairing.pairingCode} readOnly type="password" autoComplete="off" />
              <CopyText text={p.pairing.pairingCode} ariaLabel={t("agents.grokBotSetupContent.copyPairingAria")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t("agents.grokBotSetupContent.copyCode")}</CopyText>
            </div>
            <p className="text-xs text-muted-foreground">{t("agents.grokBotSetupContent.pairingExpires", { time: new Date(p.pairing.expiresAt).toLocaleTimeString() })}</p>
          </div>}
          <p role="status" aria-live="polite" className="text-muted-foreground">{binding?.connected ? t("agents.grokBotSetupContent.accessConnected") : t("agents.grokBotSetupContent.watchingAuthorization")}</p>
          <p className="text-xs text-muted-foreground">{t("agents.grokBotSetupContent.pluginsAccountWide")}</p>
        </div>}
        {p.step === 2 && <div className="space-y-4 text-sm">
          <p>{t("agents.grokBotSetupContent.routineInstructions")}</p>
          {binding && <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, p.details.botName)} label={t("agents.grokBotSetupContent.copyRoutineLabel")} title={t("agents.grokBotSetupContent.enableAssignmentsTitle")} description={t("agents.grokBotSetupContent.enableAssignmentsDescription")} />}
          <p className="text-xs text-muted-foreground">{t("agents.grokBotSetupContent.routineLinkHint")}</p>
          {routine?.configured && !p.editingCredentials && !p.webhookUrl && !p.webhookKey ? <div className="space-y-2"><p role="status" className="text-muted-foreground">{t("agents.grokBotSetupContent.credentialsStored")}</p>{p.onEditCredentials && <Button variant="outline" onClick={p.onEditCredentials} disabled={p.busy}>{t("agents.grokBotSetupContent.replaceCredentials")}</Button>}</div> : <>
            <label className="block space-y-2"><span>{t("agents.grokBotSetupContent.webhookUrl")}</span><Input value={p.webhookUrl} onChange={e => p.onCredentials(e.target.value, p.webhookKey)} type="password" autoComplete="off" spellCheck={false} /></label>
            <label className="block space-y-2"><span>{t("agents.grokBotSetupContent.webhookKey")}</span><Input value={p.webhookKey} onChange={e => p.onCredentials(p.webhookUrl, e.target.value)} type="password" autoComplete="off" spellCheck={false} /></label>
          </>}
          <p className="text-xs text-muted-foreground">{t("agents.grokBotSetupContent.copyFieldsHint")}</p>
        </div>}
        {p.step === 3 && <section aria-label={t("agents.grokBotSetupContent.checksLabel")} className="space-y-4 text-sm">
          {[{ label: t("agents.grokBotSetupContent.checkDelivered"), done: delivered }, { label: t("agents.grokBotSetupContent.checkReplied"), done: replied }].map(check => <p key={check.label} className="flex items-center gap-3">{check.done ? <Check className="size-4" /> : pending ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Circle className="size-4 text-muted-foreground" />}{check.label}<span className="text-muted-foreground">{check.done ? t("agents.grokBotSetupContent.checkComplete") : t("agents.grokBotSetupContent.checkWaiting")}</span></p>)}
          <p role="status" aria-live="polite" className="text-muted-foreground">{routine?.recoveryNeeded ? t("agents.grokBotSetupContent.statusRecovery") : ready ? t("agents.grokBotSetupContent.statusReady") : replied ? t("agents.grokBotSetupContent.statusFinishing") : exchange?.status === "rejected" ? t("agents.grokBotSetupContent.statusRejected") : delivered ? t("agents.grokBotSetupContent.statusDelivered") : t("agents.grokBotSetupContent.statusChallenge")}</p>
          <p className="text-xs text-muted-foreground">{t("agents.grokBotSetupContent.externalRunHint")}</p>
        </section>}
      </>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2"><Button variant="ghost" onClick={p.onBack} disabled={p.busy}>{t("agents.grokBotSetupContent.back")}</Button><Button variant="ghost" onClick={p.onExit} disabled={p.busy}>{t("agents.grokBotSetupContent.saveAndExit")}</Button></div>
      {p.approvalHref ? <Button asChild><Link to={p.approvalHref} onClick={p.onExit}>{t("agents.grokBotSetupContent.reviewApproval")}</Link></Button> : <Button onClick={p.onNext} disabled={nextDisabled}>{p.busy ? t("agents.grokBotSetupContent.saving") : ready ? t("agents.grokBotSetupContent.done") : p.step === 3 ? pending ? t("agents.grokBotSetupContent.waitingReply") : replied ? t("agents.grokBotSetupContent.finishingSetup") : t("agents.grokBotSetupContent.verifyConnection") : t("agents.grokBotSetupContent.continue")}</Button>}
    </div>
  </>;
}
