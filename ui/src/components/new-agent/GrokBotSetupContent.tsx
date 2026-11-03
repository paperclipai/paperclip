import { agentRoleLabel } from "@/lib/entity-labels";
import { i18n, t, useTranslation } from "@/i18n";
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
const steps = () => [t("oct19Voice.identifyBot_1t1kff0"), t("oct19Voice.connectAccess_afh3wx"), t("oct19Voice.enableAssignments_ktcowc"), t("oct19Voice.verify_cl30w4")];
export function GrokBotSetupContent(p: GrokBotSetupContentProps) {
  useTranslation();
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
        <DialogTitle className="text-xl font-semibold tracking-tight">{ready ? t("oct19Voice.yourGrokBotIsConnected_1pow1yr") : t("oct19Voice.connectYourGrokBot_1exlp5q")}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">{ready ? t("oct19Voice.grokReady", { name: p.details.botName, company: p.companyName }) : t("oct19Voice.bringGrok", { company: p.companyName })}</DialogDescription>
      </div>
      <ol aria-label={t("oct19Voice.grokBotSetup_43n4aa")} className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
        {steps().map((label, index) => <li key={label} aria-current={p.step === index ? "step" : undefined} className={p.step === index ? "font-medium text-foreground" : ""}>{index + 1}. {label}</li>)}
      </ol>
      {p.error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{p.error}</p><Button variant="outline" disabled={p.busy} onClick={p.onRetry}>{t("oct19Voice.tryAgain_982hh6")}</Button></div>}
      {p.loading ? <p role="status" className="text-sm text-muted-foreground">{t("oct19Voice.restoringSavedSetup_18miss2")}</p> : p.approvalHref ? <p className="text-sm text-muted-foreground">{t("oct19Voice.anOrganizationAdminNeedsToApprove_1ghe2y7")}</p> : <>
        {p.step === 0 && <div className="space-y-4">
          <label className="block space-y-2 text-sm"><span>{t("oct19Voice.paperclipName_17upqza")}</span><Input value={p.details.name} disabled={p.created} onChange={e => p.onDetails({ ...p.details, name: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <label className="block space-y-2 text-sm"><span>{t("oct19Voice.botNameInGrok_1c2y267")}</span><Input value={p.details.botName} disabled={p.created} onChange={e => p.onDetails({ ...p.details, botName: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <p className="text-xs text-muted-foreground">{t("oct19Voice.useTheNameShownInThe_6awqym")}</p>
          <label className="block space-y-2 text-sm"><span>{t("oct19Voice.role_1402mgp")}</span><NativeSelect disabled={p.created} value={p.details.role ?? "general"} onChange={e => p.onDetails({ ...p.details, role: e.target.value as CreateGrokInvitation["role"] })}>{AGENT_ROLES.map(role => <option key={role} value={role}>{agentRoleLabel(role)}</option>)}</NativeSelect></label>
          <label className="block space-y-2 text-sm"><span>{t("oct19Voice.manager_1u11j70")}</span><NativeSelect disabled={p.created} value={p.details.reportsTo ?? ""} onChange={e => p.onDetails({ ...p.details, reportsTo: e.target.value || null })}><option value="">{t("oct19Voice.noManager_axgz4t")}</option>{p.managers.map(manager => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</NativeSelect></label>
        </div>}
        {p.step === 1 && <div className="space-y-4 text-sm">
          <p>{t("oct19Voice.copyTheConnectionInstructionsIntoYour_162g49j")}</p>
          {p.connection?.resourceUrl && <AgentSetupPrompt prompt={buildGrokAccessPrompt(p.connection.resourceUrl, p.details.botName)} label={t("oct19Voice.copyConnectionInstructions_1utxah9")} title={t("oct19Voice.connectPaperclipAccess_19gyt4p")} description={t("oct19Voice.sendTheseInstructionsToYourBot_7l96yg")} />}
          {!binding?.connected && p.pairing && <div className="space-y-2">
            <label htmlFor={pairingCodeId}>{t("oct19Voice.oneUsePairingCode_ysxala")}</label>
            <div className="flex items-center gap-2">
              <Input id={pairingCodeId} value={p.pairing.pairingCode} readOnly type="password" autoComplete="off" />
              <CopyText text={p.pairing.pairingCode} ariaLabel={t("oct19Voice.copyPairingCode_bperj1")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t("oct19Voice.copyCode_106qgkp")}</CopyText>
            </div>
            <p className="text-xs text-muted-foreground">{t("oct19Voice.pairCodeExpires", { time: new Date(p.pairing.expiresAt).toLocaleTimeString(i18n.resolvedLanguage) })}</p>
          </div>}
          <p role="status" aria-live="polite" className="text-muted-foreground">{binding?.connected ? t("oct19Voice.agentAccessConnected_10ouh5j") : t("oct19Voice.watchingForAuthorizationThisConnectionWorks_ro6kx")}</p>
          <p className="text-xs text-muted-foreground">{t("oct19Voice.grokPluginsAreAccountWideLinking_iicy2s")}</p>
        </div>}
        {p.step === 2 && <div className="space-y-4 text-sm">
          <p>{t("oct19Voice.askYourBotToCreateA_d8kc8p")}</p>
          {binding && <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, p.details.botName)} label={t("oct19Voice.copyRoutineInstructions_a0abjh")} title={t("oct19Voice.enableAssignments_ktcowc")} description={t("oct19Voice.sendThisToTheConnectedBot_1a2hu2g")} />}
          <p className="text-xs text-muted-foreground">{t("oct19Voice.ifClickingTheRoutineDoesNothing_49ls3l")}</p>
          {routine?.configured && !p.editingCredentials && !p.webhookUrl && !p.webhookKey ? <div className="space-y-2"><p role="status" className="text-muted-foreground">{t("oct19Voice.routineCredentialsAreStoredContinueTo_1dwf0r2")}</p>{p.onEditCredentials && <Button variant="outline" onClick={p.onEditCredentials} disabled={p.busy}>{t("oct19Voice.replaceRoutineCredentials_13pno8h")}</Button>}</div> : <>
            <label className="block space-y-2"><span>{t("oct19Voice.webhookUrl_ijsn3v")}</span><Input value={p.webhookUrl} onChange={e => p.onCredentials(e.target.value, p.webhookKey)} type="password" autoComplete="off" spellCheck={false} /></label>
            <label className="block space-y-2"><span>{t("oct19Voice.webhookKey_nzli0p")}</span><Input value={p.webhookKey} onChange={e => p.onCredentials(p.webhookUrl, e.target.value)} type="password" autoComplete="off" spellCheck={false} /></label>
          </>}
          <p className="text-xs text-muted-foreground">{t("oct19Voice.copyTheseFieldsDirectlyFromGrok_19eqyz5")}</p>
        </div>}
        {p.step === 3 && <section aria-label={t("oct19Voice.grokConnectionChecks_v977nn")} className="space-y-4 text-sm">
          {[{ label: t("oct19Voice.assignmentDelivered_eetk08"), done: delivered }, { label: t("oct19Voice.replyReceived_270brm"), done: replied }].map(check => <p key={check.label} className="flex items-center gap-3">{check.done ? <Check className="size-4" /> : pending ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Circle className="size-4 text-muted-foreground" />}{check.label}<span className="text-muted-foreground">{check.done ? t("oct19Voice.complete_rcgk2q") : t("oct19Voice.waiting_1jufdxk")}</span></p>)}
          <p role="status" aria-live="polite" className="text-muted-foreground">{routine?.recoveryNeeded ? t("oct19Voice.recoveryNeededInspectGrokSActivity_htjkt9") : ready ? t("oct19Voice.bothDirectionsVerifiedYourBotIs_1k6okjc") : replied ? t("oct19Voice.bothDirectionsVerifiedPaperclipIsFinishing_14uvmr") : exchange?.status === "rejected" ? t("oct19Voice.theRoutineRejectedDeliveryCheckIts_xdklob") : delivered ? t("oct19Voice.theRoutineAcceptedDeliveryWaitingFor_178wpn0") : t("oct19Voice.sendAHarmlessChallengeThisCreates_evgp4x")}</p>
          <p className="text-xs text-muted-foreground">{t("oct19Voice.grokRunsExternallyUsageAndSpending_agxe67")}</p>
        </section>}
      </>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2"><Button variant="ghost" onClick={p.onBack} disabled={p.busy}>{t("oct19Voice.back_1hzmxtu")}</Button><Button variant="ghost" onClick={p.onExit} disabled={p.busy}>{t("oct19Voice.saveExit_10o0pue")}</Button></div>
      {p.approvalHref ? <Button asChild><Link to={p.approvalHref} onClick={p.onExit}>{t("oct19Voice.reviewApproval_jntaqg")}</Link></Button> : <Button onClick={p.onNext} disabled={nextDisabled}>{p.busy ? t("oct19Voice.saving_w7dncv") : ready ? t("oct19Voice.done_13cn9g1") : p.step === 3 ? pending ? t("oct19Voice.waitingForReply_2m26wj") : replied ? t("oct19Voice.finishingSetup_oq5xub") : t("oct19Voice.verifyConnection_1v2fb24") : t("oct19Voice.continue_1bipuuc")}</Button>}
    </div>
  </>;
}
