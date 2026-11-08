import { getAgentRoleLabel } from "@/adapters/display-translations";
import { useTranslation, t } from "@/i18n";
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
const steps = () => [t("agent-config:identifyBot_742eb39"), t("agent-config:connectAccess_e1447d2"), t("agent-config:enableAssignments_45d6602"), t("agent-config:verify_dda6ac2")];
export function GrokBotSetupContent(p: GrokBotSetupContentProps) {
  const { t } = useTranslation("agent-config");
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
        <DialogTitle className="text-xl font-semibold tracking-tight">{ready ? t("agent-config:yourGrokBotIsConnected_f11c820") : t("agent-config:connectYourGrokBot_c5cbfed")}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">{ready ? t("agent-config:valueCanReceiveAssignmentsAndWorkWithValue_f129c2c", { value1: p.details.botName, value2: p.companyName }) : t("agent-config:bringAnExistingBotIntoValueItContinues_6f54416", { value1: p.companyName })}</DialogDescription>
      </div>
      <ol aria-label={t("agent-config:grokBotSetup_9094d24")} className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
        {steps().map((label, index) => <li key={label} aria-current={p.step === index ? "step" : undefined} className={p.step === index ? "font-medium text-foreground" : ""}>{index + 1}. {label}</li>)}
      </ol>
      {p.error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{p.error}</p><Button variant="outline" disabled={p.busy} onClick={p.onRetry}>{t("agent-config:tryAgain_042c862")}</Button></div>}
      {p.loading ? <p role="status" className="text-sm text-muted-foreground">{t("agent-config:restoringSavedSetup_833329e")}</p> : p.approvalHref ? <p className="text-sm text-muted-foreground">{t("agent-config:anOrganizationAdminNeedsToApproveThisAgent_eea6d6f")}</p> : <>
        {p.step === 0 && <div className="space-y-4">
          <label className="block space-y-2 text-sm"><span>{t("agent-config:paperclipName_33d056a")}</span><Input value={p.details.name} disabled={p.created} onChange={e => p.onDetails({ ...p.details, name: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <label className="block space-y-2 text-sm"><span>{t("agent-config:botNameInGrok_01c6f8b")}</span><Input value={p.details.botName} disabled={p.created} onChange={e => p.onDetails({ ...p.details, botName: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <p className="text-xs text-muted-foreground">{t("agent-config:useTheNameShownInTheGrokBot_e6cade0")}</p>
          <label className="block space-y-2 text-sm"><span>{t("agent-config:role_c3f104d")}</span><NativeSelect disabled={p.created} value={p.details.role ?? "general"} onChange={e => p.onDetails({ ...p.details, role: e.target.value as CreateGrokInvitation["role"] })}>{AGENT_ROLES.map(role => <option key={role} value={role}>{getAgentRoleLabel(role)}</option>)}</NativeSelect></label>
          <label className="block space-y-2 text-sm"><span>{t("agent-config:manager_babe305")}</span><NativeSelect disabled={p.created} value={p.details.reportsTo ?? ""} onChange={e => p.onDetails({ ...p.details, reportsTo: e.target.value || null })}><option value="">{t("agent-config:noManager_448906b")}</option>{p.managers.map(manager => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</NativeSelect></label>
        </div>}
        {p.step === 1 && <div className="space-y-4 text-sm">
          <p>{t("agent-config:copyTheConnectionInstructionsIntoYourBotS_cc927c1")}</p>
          {p.connection?.resourceUrl && <AgentSetupPrompt prompt={buildGrokAccessPrompt(p.connection.resourceUrl, p.details.botName)} label={t("agent-config:copyConnectionInstructions_8fd7e8d")} title={t("agent-config:connectPaperclipAccess_a6468f5")} description={t("agent-config:sendTheseInstructionsToYourBotThePairing_8f795aa")} />}
          {!binding?.connected && p.pairing && <div className="space-y-2">
            <label htmlFor={pairingCodeId}>{t("agent-config:oneUsePairingCode_5279abe")}</label>
            <div className="flex items-center gap-2">
              <Input id={pairingCodeId} value={p.pairing.pairingCode} readOnly type="password" autoComplete="off" />
              <CopyText text={p.pairing.pairingCode} ariaLabel={t("agent-config:copyPairingCode_d9898ea")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t("agent-config:copyCode_6c10692")}</CopyText>
            </div>
            <p className="text-xs text-muted-foreground">{t("agent-config:copyThisCodeIntoPaperclipSAuthorizationPage_d19f592")} {new Date(p.pairing.expiresAt).toLocaleTimeString()}.</p>
          </div>}
          <p role="status" aria-live="polite" className="text-muted-foreground">{binding?.connected ? t("agent-config:agentAccessConnected_d78552c") : t("agent-config:watchingForAuthorizationThisConnectionWorksAsThe_a024c9f")}</p>
          <p className="text-xs text-muted-foreground">{t("agent-config:grokPluginsAreAccountWideLinkingOneBot_aa6cb30")}</p>
        </div>}
        {p.step === 2 && <div className="space-y-4 text-sm">
          <p>{t("agent-config:askYourBotToCreateAWebhookOnly_3c61a21")}</p>
          {binding && <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, p.details.botName)} label={t("agent-config:copyRoutineInstructions_1181be1")} title={t("agent-config:enableAssignments_45d6602")} description={t("agent-config:sendThisToTheConnectedBotTheRoutine_21975c4")} />}
          <p className="text-xs text-muted-foreground">{t("agent-config:ifClickingTheRoutineDoesNothingUseThe_44f0f98")}</p>
          {routine?.configured && !p.editingCredentials && !p.webhookUrl && !p.webhookKey ? <div className="space-y-2"><p role="status" className="text-muted-foreground">{t("agent-config:routineCredentialsAreStoredContinueToVerifyBoth_5f3785e")}</p>{p.onEditCredentials && <Button variant="outline" onClick={p.onEditCredentials} disabled={p.busy}>{t("agent-config:replaceRoutineCredentials_8b80720")}</Button>}</div> : <>
            <label className="block space-y-2"><span>{t("agent-config:webhookUrl")}</span><Input value={p.webhookUrl} onChange={e => p.onCredentials(e.target.value, p.webhookKey)} type="password" autoComplete="off" spellCheck={false} /></label>
            <label className="block space-y-2"><span>{t("agent-config:webhookKey_4874a0a")}</span><Input value={p.webhookKey} onChange={e => p.onCredentials(p.webhookUrl, e.target.value)} type="password" autoComplete="off" spellCheck={false} /></label>
          </>}
          <p className="text-xs text-muted-foreground">{t("agent-config:copyTheseFieldsDirectlyFromGrokIntoPaperclip_c1e6493")}</p>
        </div>}
        {p.step === 3 && <section aria-label={t("agent-config:grokConnectionChecks_3e39541")} className="space-y-4 text-sm">
          {[{ label: t("agent-config:assignmentDelivered_42361cf"), done: delivered }, { label: t("agent-config:replyReceived_2b611b3"), done: replied }].map(check => <p key={check.label} className="flex items-center gap-3">{check.done ? <Check className="size-4" /> : pending ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Circle className="size-4 text-muted-foreground" />}{check.label}<span className="text-muted-foreground">{check.done ? t("agent-config:complete_1f5a1ab") : t("agent-config:waiting_33d3063")}</span></p>)}
          <p role="status" aria-live="polite" className="text-muted-foreground">{routine?.recoveryNeeded ? t("agent-config:recoveryNeededInspectGrokSActivityInThis_0dde28d") : ready ? t("agent-config:bothDirectionsVerifiedYourBotIsReadyFor_499a915") : replied ? t("agent-config:bothDirectionsVerifiedPaperclipIsFinishingAgentSetup_47708df") : exchange?.status === "rejected" ? t("agent-config:theRoutineRejectedDeliveryCheckItsUrlAnd_3824fdd") : delivered ? t("agent-config:theRoutineAcceptedDeliveryWaitingForAnAuthenticated_02ef887") : t("agent-config:sendAHarmlessChallengeThisCreatesNoTask_7ddf6a5")}</p>
          <p className="text-xs text-muted-foreground">{t("agent-config:grokRunsExternallyUsageAndSpendingAreNot_2e5d775")}</p>
        </section>}
      </>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2"><Button variant="ghost" onClick={p.onBack} disabled={p.busy}>{t("agent-config:back_b52b36b")}</Button><Button variant="ghost" onClick={p.onExit} disabled={p.busy}>{t("agent-config:saveExit_fc5599f")}</Button></div>
      {p.approvalHref ? <Button asChild><Link to={p.approvalHref} onClick={p.onExit}>{t("agent-config:reviewApproval_2ee7925")}</Link></Button> : <Button onClick={p.onNext} disabled={nextDisabled}>{p.busy ? t("agent-config:saving_56a2285") : ready ? t("agent-config:done_e9b450d") : p.step === 3 ? pending ? t("agent-config:waitingForReply_2d7568d") : replied ? t("agent-config:finishingSetup_0744df9") : t("agent-config:verifyConnection_a5073da") : t("agent-config:continue_2e02623")}</Button>}
    </div>
  </>;
}
