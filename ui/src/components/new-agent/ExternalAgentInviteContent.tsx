import { agentRoleLabel } from "@/lib/entity-labels";
import { t, useTranslation } from "@/i18n";
import { useId } from "react";
import { AGENT_ROLES } from "@paperclipai/shared";
import type { MuseInvitationDraft } from "@/lib/muse-invitation-draft";
import { Input } from "../ui/input";
import { Link } from "@/lib/router";
import { ArrowLeft, Bot, Check, Circle, CircleAlert, Loader2 } from "lucide-react";
import { AdapterMark } from "../AdapterMark";
import { AgentSetupPrompt } from "../AgentSetupPrompt";
import { Button } from "../ui/button";
import { DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "@/lib/utils";

export type ExternalAgentPreset = "dot" | "grok_bot" | "muse" | "hermes" | "other";
export type DotConnectionState = {
  phase: "waiting" | "connected" | "subscribed" | "testing" | "finishing" | "ready";
  problem?: "event_timeout" | "prompt_unavailable" | "offline" | "agent_unavailable";
};

const presets = () => [
  { id: "dot", name: "Dot", adapter: "openai_dot", description: t("oct19Voice.yourDotInChatgpt_x6b037") },
  { id: "grok_bot", name: "Grok Bot", adapter: "grok_bot", description: t("oct19Voice.anExistingBotInGrok_57yr24") },
  { id: "muse", name: t("oct19Voice.musePersonalAgent_bx5cxw"), adapter: "muse", description: t("oct19Voice.yourPersonalMuseAtMuseAi_erpoqz") },
  { id: "hermes", name: "Hermes", adapter: "hermes_gateway", description: t("oct19Voice.anExistingHermesAgent_18kz3by") },
  { id: "other", name: t("oct19Voice.other_ukzedx"), adapter: "http", description: t("oct19Voice.anyAgentThatCanConnectTo_ip4l6e") },
] as const;

export function ExternalAgentPresetPicker({ onSelect, dotDisabledReason, grokDisabledReason, museEnabled = false }: { onSelect: (preset: ExternalAgentPreset) => void; dotDisabledReason?: string; grokDisabledReason?: string; museEnabled?: boolean }) {
  useTranslation();
  return <div className={cn("grid grid-cols-2 gap-3", !museEnabled && "sm:grid-cols-4")}>
    {presets().filter(preset => preset.id !== "muse" || museEnabled).map(preset => <button
      key={preset.id}
      type="button"
      onClick={() => onSelect(preset.id)}
      disabled={preset.id === "dot" && !!dotDisabledReason || preset.id === "grok_bot" && !!grokDisabledReason}
      title={preset.id === "dot" ? dotDisabledReason : preset.id === "grok_bot" ? grokDisabledReason : undefined}
      className="flex aspect-square flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-3 py-4 text-center transition-colors disabled:opacity-50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AdapterMark type={preset.adapter} className="size-8" />
      <span className="text-sm font-medium">{preset.name}</span>
      <span className="sr-only">{preset.description}</span>
    </button>)}
  </div>;
}

const checks = () => [
  { title: t("oct19Voice.connectedToPaperclip_keks1"), description: t("oct19Voice.yourDotHasConnectedToThis_1rgn2fq") },
  { title: t("oct19Voice.taskUpdatesEnabled_ixf70z"), description: t("oct19Voice.yourDotIsSubscribedToNew_wvaxtl") },
  { title: t("oct19Voice.testEventConfirmed_gzk0wo"), description: t("oct19Voice.yourDotReceivedOurTestAnd_1g97z4b") },
];

/** Controlled by server evidence in the invite controller, never by copying a prompt. */
export function DotConnectionChecks({ state }: { state: DotConnectionState }) {
  useTranslation();
  const completed = { waiting: 0, connected: 1, subscribed: 2, testing: 2, finishing: 3, ready: 3 }[state.phase];
  const message = state.problem === "agent_unavailable" ? t("oct19Voice.connectionChecksPassedButThisAgent_1d2k8dq")
    : state.problem === "offline" ? t("oct19Voice.connectionUpdatesPausedReconnectToCheck_1f1fpgf")
    : state.problem === "prompt_unavailable" ? t("oct19Voice.thisSetupPromptWasReplacedIn_ps4zk2")
    : state.problem === "event_timeout" ? t("oct19Voice.yourDotConnectedButHasnT_1qrnfl8")
    : state.phase === "finishing" ? t("oct19Voice.yourDotConfirmedTheTestEvent_1hzah7w")
    : state.phase === "ready" ? t("oct19Voice.yourDotIsReadyForTasks_8jll7g")
    : state.phase === "waiting" ? t("oct19Voice.watchingForYourDotUpdatesWill_1kejx0p")
    : state.phase === "connected" ? t("oct19Voice.yourDotConnectedWaitingForIt_1dhvthq")
    : t("oct19Voice.waitingForYourDotToConfirm_1gih6pc");
  return <section aria-label={t("oct19Voice.dotConnectionChecks_85vmrd")} className="space-y-4">
    <ol className="space-y-4">
      {checks().map((check, index) => {
        const done = index < completed;
        const failed = index === completed && state.problem === "event_timeout";
        const active = index === completed && !state.problem;
        const Icon = done ? Check : failed ? CircleAlert : active ? Loader2 : Circle;
        return <li key={check.title} className="flex items-start gap-3" aria-current={active ? "step" : undefined}>
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", done ? "bg-accent text-foreground" : failed ? "text-destructive" : "text-muted-foreground")}>
            <Icon className={cn("size-4", active && "animate-spin motion-reduce:animate-none")} />
          </span>
          <div className="min-w-0 pt-0.5">
            <p className={cn("text-sm", done || active || failed ? "font-medium" : "text-muted-foreground")}>
              {check.title}<span className="sr-only">{done ? t("oct19Voice.complete_f87q0k") : failed ? t("oct19Voice.needsAttention_150zfda") : active ? t("oct19Voice.inProgress_1wp4onz") : t("oct19Voice.waiting_12xb3xe")}</span>
            </p>
            {done && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{check.description}</p>}
          </div>
        </li>;
      })}
    </ol>
    <p role={state.problem && state.problem !== "prompt_unavailable" ? "alert" : "status"} aria-live="polite" className={cn("text-sm leading-relaxed", state.problem && state.problem !== "prompt_unavailable" ? "text-destructive" : "text-muted-foreground")}>{message}</p>
  </section>;
}

export type MuseConnectionState = {
  paired: boolean;
  receiverDetected: boolean;
  backgroundReplyVerified: boolean;
  ready: boolean;
  finishing?: boolean;
  testing?: boolean;
  problem?: "no_recent_response" | "prompt_unavailable" | "offline" | "agent_unavailable" | "disconnected" | "disabled" | "connection_expired";
};

/** Receiver contact is separate from an authenticated, independent worker reply. */
export function MuseConnectionChecks({ state }: { state: MuseConnectionState }) {
  useTranslation();
  const milestones = [
    { title: t("oct19Voice.pairedWithPaperclip_yew6ro"), done: state.paired, description: t("oct19Voice.paperclipAuthorizedTheScopedMuseAgent_jdi67e") },
    { title: t("oct19Voice.receiverDetected_2nv2bi"), done: state.receiverDetected, description: t("oct19Voice.paperclipObservedAPublicReceiverCheck_1awbfam") },
    { title: t("oct19Voice.backgroundReplyVerified_1nkm2m7"), done: state.backgroundReplyVerified, description: t("oct19Voice.museRepliedToAnIndependentBackground_y89kke") },
  ];
  const checksPassed = milestones.every(item => item.done);
  const message = state.problem === "offline" ? t("oct19Voice.connectionUpdatesPausedRefreshToCheck_8by63g")
    : state.problem === "disconnected" ? t("oct19Voice.disconnectedTheseAreTheLastObserved_10xhjwi")
    : state.problem === "connection_expired" ? t("oct19Voice.thisMuseConnectionExpiredReconnectMuse_bhodbv")
    : state.problem === "disabled" ? t("oct19Voice.museIsDisabledTheseAreThe_snf6af")
    : state.problem === "prompt_unavailable" ? t("oct19Voice.thisSetupPromptWasReplacedOr_1gy63o0")
    : state.problem === "agent_unavailable" ? t("oct19Voice.connectionChecksPassedResolveThisAgent_1gbw8z2")
    : state.problem === "no_recent_response" ? t("oct19Voice.noRecentResponseOpenMuseTo_5ied6c")
    : state.testing ? t("oct19Voice.waitingForMuseToReplyTo_1f3n587")
    : checksPassed && state.ready ? t("oct19Voice.museIsReadyForTasksAll_10i63fm")
    : checksPassed ? t("oct19Voice.allConnectionChecksPassedPaperclipIs_1nf0z86")
    : !state.paired ? t("oct19Voice.watchingForMuseToPairCopy_6swq46")
    : !state.receiverDetected ? t("oct19Voice.museIsPairedWaitingForThe_uwngql")
    : t("oct19Voice.receiverDetectedWaitingForMuseTo_1voq0un");
  return <section aria-label={t("oct19Voice.museConnectionChecks_i025ge")} className="space-y-4">
    <ol className="space-y-4">
      {milestones.map(item => <li key={item.title} className="flex items-start gap-3">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", item.done ? "bg-accent text-foreground" : "text-muted-foreground")}>
          {item.done ? <Check className="size-4" /> : <Circle className="size-4" />}
        </span>
        <div className="min-w-0 pt-0.5">
          <p className={cn("text-sm", item.done ? "font-medium" : "text-muted-foreground")}>
            {item.title}<span className="sr-only">{item.done ? t("oct19Voice.complete_f87q0k") : t("oct19Voice.waiting_12xb3xe")}</span>
          </p>
          {item.done && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.description}</p>}
        </div>
      </li>)}
    </ol>
    <p role="status" aria-live="polite" className="text-sm leading-relaxed text-muted-foreground">{message}</p>
  </section>;
}

/** Shared presentation for the invitation flow. The caller owns invitations and watching. */
export function ExternalAgentInviteContent({
  preset, prompt, companyName, connection, onSelect, onBack, onClose, onCopied, onRetry, onNewPrompt,
  dotDisabledReason, grokDisabledReason, busy = false, error, approvalHref, museEnabled = false, museConnection, museDraft, onMuseDraftChange, onMuseContinue,
}: {
  museEnabled?: boolean;
  museConnection?: MuseConnectionState;
  museDraft?: MuseInvitationDraft;
  onMuseDraftChange?: (draft: MuseInvitationDraft) => void;
  onMuseContinue?: () => void;
  dotDisabledReason?: string;
  grokDisabledReason?: string;
  busy?: boolean;
  error?: string;
  approvalHref?: string;
  preset: ExternalAgentPreset | null;
  prompt: string;
  companyName: string;
  connection: DotConnectionState;
  onSelect: (preset: ExternalAgentPreset) => void;
  onBack: () => void;
  onClose: () => void;
  onCopied: () => void;
  onRetry: () => void;
  onNewPrompt: () => void;
}) {
  useTranslation();
  const detailsId = useId();
  const muse = preset === "muse";
  const museDetails = muse && !!museDraft;
  const museAwaitingInvitation = muse && !museDetails && !museConnection && !approvalHref;
  const museReady = muse && !!museConnection?.ready && museConnection.paired && museConnection.receiverDetected && museConnection.backgroundReplyVerified && !museConnection.problem && !museConnection.testing;
  const provider = presets().find(item => item.id === preset);
  const dot = preset === "dot";
  const ready = museReady || (dot && connection.phase === "ready" && !connection.problem);
  const connecting = dot && connection.phase !== "waiting";
  const progressLabel = connection.problem === "agent_unavailable" ? t("oct19Voice.agentUnavailable_ft9sak")
    : connection.problem === "offline" ? t("oct19Voice.updatesPaused_13g2a4h")
    : connection.problem === "event_timeout" ? t("oct19Voice.needsAttention_pwuroc")
    : connection.phase === "finishing" ? t("oct19Voice.finishingSetup_oq5xub")
    : connection.phase === "connected" ? t("oct19Voice.connecting_1puhp9v") : t("oct19Voice.confirmingConnection_lp44br");
  return <>
    <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6 pt-8 sm:px-8">
      <div className="space-y-3 pr-5">
        {muse && <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" />{t("oct19Voice.back_1hzmxtu")}</Button>}
        {provider && <AdapterMark type={provider.adapter} className="size-10" />}
        <div className="space-y-2">
          <DialogTitle className="text-xl font-semibold tracking-tight">
            {!provider ? t("oct19Voice.inviteAnExternalAgent_1j0k98b") : muse ? ready ? t("oct19Voice.museIsConnected_1r13dmu") : museDetails || museAwaitingInvitation ? t("oct19Voice.inviteYourMuse_l4zp1b") : t("oct19Voice.connectYourMuse_1k18uqe") : dot ? ready ? t("oct19Voice.yourDotIsConnected_1q1v2c4") : t("oct19Voice.connectYourDot_1qss09r") : preset === "hermes" ? t("oct19Voice.inviteYourHermesAgent_ihbwty") : t("oct19Voice.inviteYourAgent_pzd50q")}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {!provider ? t("oct19Voice.bringAgent", { company: companyName })
              : muse ? museDetails ? t("oct19Voice.museNameRole", { company: companyName })
              : museAwaitingInvitation ? t("oct19Voice.museRequiresAnAuthenticatedPaperclipInstance_vmkbig")
              : ready ? t("oct19Voice.museReady", { company: companyName })
              : !prompt && !museConnection?.paired ? t("oct19Voice.weReCheckingWhetherThisInstance_1c7wytz")
              : t("oct19Voice.pasteTheSetupPromptIntoYour_17v1tal")
              : ready ? t("oct19Voice.dotReady", { company: companyName })
              : connection.problem === "agent_unavailable" ? t("oct19Voice.yourDotIsConnectedThisAgent_g7gtri")
              : connection.phase === "finishing" ? t("oct19Voice.yourDotHasConnectedAndConfirmed_a68cwt")
              : connecting ? t("oct19Voice.yourDotHasConnectedWeRe_iawpal")
              : dot ? t("oct19Voice.copyTheSetupPromptAndSend_1wbvuhj")
              : t(preset === "hermes" ? "oct19Voice.inviteHermes" : "oct19Voice.inviteOther")}
          </DialogDescription>
        </div>
      </div>
      {error && <div role="alert" className="space-y-3 text-sm text-destructive"><p>{error}</p>{!museAwaitingInvitation && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("oct19Voice.tryAgain_982hh6")}</Button>}</div>}
      {!provider ? <><ExternalAgentPresetPicker onSelect={onSelect} dotDisabledReason={dotDisabledReason} grokDisabledReason={grokDisabledReason} museEnabled={museEnabled} />
        {dotDisabledReason && <p className="text-sm text-muted-foreground">{dotDisabledReason}</p>}{grokDisabledReason && grokDisabledReason !== dotDisabledReason && <p className="text-sm text-muted-foreground">{grokDisabledReason}</p>}</>
        : approvalHref ? <p className="text-sm text-muted-foreground">{t("oct19Voice.approvalNeeded", { provider: muse ? "Muse" : "Dot" })}</p>
        : museAwaitingInvitation ? busy ? <p role="status" className="text-sm text-muted-foreground">{t("oct19Voice.loadingMuseInvitation_1iw1sx0")}</p> : null
        : muse && busy && !museDetails && !prompt && !museConnection?.paired ? <p role="status" className="text-sm text-muted-foreground">{t("oct19Voice.loadingMuseSetup_daivj0")}</p>
        : museDetails ? <form id={detailsId} className="space-y-4" onSubmit={event => { event.preventDefault(); if (museDraft.name.trim() && !busy) onMuseContinue?.(); }}>
          <div className="space-y-2">
            <label htmlFor={`${detailsId}-name`} className="text-sm font-medium">{t("oct19Voice.agentName_xw70bd")}</label>
            <Input id={`${detailsId}-name`} disabled={busy} autoFocus maxLength={100} value={museDraft.name} placeholder="Muse" onChange={event => onMuseDraftChange?.({ ...museDraft, name: event.target.value })} />
          </div>
          <div className="space-y-2">
            <label htmlFor={`${detailsId}-role`} className="text-sm font-medium">{t("oct19Voice.role_1402mgp")}</label>
            <select id={`${detailsId}-role`} disabled={busy} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={museDraft.role} onChange={event => {
              const role = AGENT_ROLES.find(value => value === event.target.value);
              if (role) onMuseDraftChange?.({ ...museDraft, role });
            }}>{AGENT_ROLES.map(role => <option key={role} value={role}>{agentRoleLabel(role)}</option>)}</select>
          </div>
          <p className="text-xs text-muted-foreground">{t("oct19Voice.museUsesItsOwnApprovedTools_1xzgtgc")}</p>
        </form>
        : muse && museConnection ? <>
          <MuseConnectionChecks state={museConnection} />
          {museConnection.problem === "no_recent_response" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("oct19Voice.testBackgroundReply_1vy7683")}</Button>}
          {museConnection.problem === "offline" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("oct19Voice.refreshConnection_7d3lxo")}</Button>}
          {!museConnection.paired && <a href="https://muse.ai" target="_blank" rel="noopener noreferrer" className="inline-flex text-sm text-foreground underline underline-offset-4">{t("oct19Voice.openMuse_pbmdvp")}</a>}
          <p className="text-xs text-muted-foreground">{t("oct19Voice.receiverContactIsPersistedInBatches_gvu1ek")}</p>
        </>
        : busy && !prompt && connection.phase === "waiting" ? <p role="status" className="text-sm text-muted-foreground">{t("oct19Voice.preparingYourInvitation_cuc2ll")}</p> : dot ? <>
        <div className="border-t pt-6"><DotConnectionChecks state={connection} />
          {connection.phase === "waiting" && <p className="mt-4 text-xs text-muted-foreground">{t("oct19Voice.dotUsesYourOpenaiAccountProvider_19sqpvb")}</p>}</div>
        {connection.problem === "event_timeout" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("oct19Voice.retryTestEvent_1bg10ev")}</Button>}
        {connection.problem === "offline" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("oct19Voice.reconnectUpdates_qzootk")}</Button>}
      </> : <p className="text-sm leading-relaxed text-muted-foreground">{t("oct19Voice.invitationDescription", { company: companyName })}</p>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={muse ? onClose : provider ? onBack : onClose}>
          {provider && !muse && <ArrowLeft className="size-4" />}{muse ? ready ? t("oct19Voice.close_1l0xxoj") : t("oct19Voice.saveExit_10o0pue") : provider ? t("oct19Voice.back_1hzmxtu") : t("oct19Voice.cancel_ew9em3")}
        </Button>
      </div>
      {provider && (approvalHref ? <Button asChild><Link to={approvalHref} onClick={onClose}>{t("oct19Voice.reviewApproval_jntaqg")}</Link></Button>
        : museDetails ? <Button type="submit" form={detailsId} disabled={busy || !museDraft.name.trim()}>{busy ? t("oct19Voice.preparing_1h0c06j") : t("oct19Voice.continue_1bipuuc")}</Button>
        : ready ? <Button onClick={onClose}>{t("oct19Voice.done_13cn9g1")}</Button>
        : museAwaitingInvitation ? <Button disabled={busy} onClick={onRetry}>{busy ? t("oct19Voice.loadingSetup_1plqu2o") : t("oct19Voice.refreshSetup_n70wm1")}</Button>
        : muse ? museConnection?.problem === "disconnected" || museConnection?.problem === "connection_expired" ? <Button disabled={busy} onClick={onNewPrompt}>{t("oct19Voice.reconnectMuse_1y26e98")}</Button>
          : museConnection?.problem === "prompt_unavailable" ? <Button disabled={busy} onClick={onNewPrompt}>{t("oct19Voice.createANewPrompt_9mn07q")}</Button>
          : !museConnection?.paired && prompt ? <AgentSetupPrompt key={prompt} prompt={prompt} label={t("oct19Voice.copySetupPrompt_1qzokyx")} title={t("oct19Voice.connectYourMuse_1k18uqe")} agent={{ name: "Muse", icon: <Bot className="size-5" /> }} description={t("oct19Voice.sendThisWholePromptToYour_1m31tjy")} align="end" className="min-w-0 shrink" onCopied={onCopied} />
          : busy ? <Button disabled>{t("oct19Voice.preparing_1h0c06j")}</Button>
          : <Button asChild><a href="https://muse.ai" target="_blank" rel="noopener noreferrer">{t("oct19Voice.openMuse_pbmdvp")}</a></Button>
        : connecting ? <Button disabled aria-live="polite">
          {!connection.problem && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {progressLabel}
        </Button>
        : dot && connection.problem === "prompt_unavailable" ? <Button disabled={busy} onClick={onNewPrompt}>{t("oct19Voice.createANewPrompt_9mn07q")}</Button>
        : !prompt || busy ? <Button disabled>{busy ? t("oct19Voice.preparing_1h0c06j") : t("oct19Voice.waitingForDot_1lo4drm")}</Button>
        : <AgentSetupPrompt
          key={preset}
          prompt={prompt}
          label={dot ? t("oct19Voice.copySetupPrompt_1qzokyx") : t("oct19Voice.copyInvitationPrompt_1taa6dj")}
          title={dot ? t("oct19Voice.connectYourDot_1qss09r") : t("oct19Voice.inviteYourAgent_pzd50q")}
          description={dot ? t("oct19Voice.sendThisWholePromptToYour_1t7n2f5") : t("oct19Voice.sendThisWholePromptToYour_p1lrp1")}
          agent={dot ? { name: "Dot", src: "/brands/adapters/openai-dot.svg" } : undefined}
          align="end"
          className="min-w-0 shrink"
          onCopied={onCopied}
        />)}
    </div>
  </>;
}
