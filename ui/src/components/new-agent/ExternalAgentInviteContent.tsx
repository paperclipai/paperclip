import { useTranslation, t } from "@/i18n";
import { useId } from "react";
import { getAgentRoleLabel } from "@/adapters/display-translations";
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

const presets = [
  { id: "dot", get name() { return t("agent-config:dot_46856bf"); }, adapter: "openai_dot", get description() { return t("agent-config:yourDotInChatgpt_80718a2"); } },
  { id: "grok_bot", get name() { return t("agent-config:grokBot_c2ced68"); }, adapter: "grok_bot", get description() { return t("agent-config:anExistingBotInGrok_1676c7a"); } },
  { id: "muse", get name() { return t("agent-config:musePersonalAgent_9c8bd19"); }, adapter: "muse", get description() { return t("agent-config:yourPersonalMuseAtMuseAi_5d38a14"); } },
  { id: "hermes", get name() { return t("agent-config:hermes_3e06620"); }, adapter: "hermes_gateway", get description() { return t("agent-config:anExistingHermesAgent_d31e945"); } },
  { id: "other", get name() { return t("agent-config:other_6e6a6f2"); }, adapter: "http", get description() { return t("agent-config:anyAgentThatCanConnectToPaperclip_7eb30b4"); } },
] as const;

export function ExternalAgentPresetPicker({ onSelect, dotDisabledReason, grokDisabledReason, museEnabled = false }: { onSelect: (preset: ExternalAgentPreset) => void; dotDisabledReason?: string; grokDisabledReason?: string; museEnabled?: boolean }) {
  useTranslation("agent-config");
  return <div className={cn("grid grid-cols-2 gap-3", !museEnabled && "sm:grid-cols-4")}>
    {presets.filter(preset => preset.id !== "muse" || museEnabled).map(preset => <button
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

const checks = [
  { get title() { return t("agent-config:connectedToPaperclip_250f166"); }, get description() { return t("agent-config:yourDotHasConnectedToThisAgent_219e451"); } },
  { get title() { return t("agent-config:taskUpdatesEnabled_9d413c6"); }, get description() { return t("agent-config:yourDotIsSubscribedToNewAssignmentsAnd_e01eb32"); } },
  { get title() { return t("agent-config:testEventConfirmed_3441877"); }, get description() { return t("agent-config:yourDotReceivedOurTestAndRepliedTo_49bcda1"); } },
];

/** Controlled by server evidence in the invite controller, never by copying a prompt. */
export function DotConnectionChecks({ state }: { state: DotConnectionState }) {
  const { t } = useTranslation("agent-config");
  const completed = { waiting: 0, connected: 1, subscribed: 2, testing: 2, finishing: 3, ready: 3 }[state.phase];
  const message = state.problem === "agent_unavailable" ? t("agent-config:connectionChecksPassedButThisAgentCannotReceive_6a823dc")
    : state.problem === "offline" ? t("agent-config:connectionUpdatesPausedReconnectToCheckTheLatest_896629b")
    : state.problem === "prompt_unavailable" ? t("agent-config:thisSetupPromptWasReplacedInAnotherWindow_7fa0fee")
    : state.problem === "event_timeout" ? t("agent-config:yourDotConnectedButHasnTConfirmedThe_731ad40")
    : state.phase === "finishing" ? t("agent-config:yourDotConfirmedTheTestEventPaperclipIs_7110062")
    : state.phase === "ready" ? t("agent-config:yourDotIsReadyForTasksMessagesCan_5ca0737")
    : state.phase === "waiting" ? t("agent-config:watchingForYourDotUpdatesWillAppearHere_71b27a5")
    : state.phase === "connected" ? t("agent-config:yourDotConnectedWaitingForItToEnable_c33f265")
    : t("agent-config:waitingForYourDotToConfirmATest_de99cde");
  return <section aria-label={t("agent-config:dotConnectionChecks_f4c4097")} className="space-y-4">
    <ol className="space-y-4">
      {checks.map((check, index) => {
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
              {check.title}<span className="sr-only">{done ? t("agent-config:complete_6fbfa08") : failed ? t("agent-config:needsAttention_9649197") : active ? t("agent-config:inProgress_2dbeb69") : t("agent-config:waiting_86114ea")}</span>
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
  const { t } = useTranslation("agent-config");
  const milestones = [
    { title: t("agent-config:pairedWithPaperclip_e9a4eca"), done: state.paired, description: t("agent-config:paperclipAuthorizedTheScopedMuseAgentConnection_8fa8914") },
    { title: t("agent-config:receiverDetected_6655fe4"), done: state.receiverDetected, description: t("agent-config:paperclipObservedAPublicReceiverCheckOnlyAn_d1d625a") },
    { title: t("agent-config:backgroundReplyVerified_0008931"), done: state.backgroundReplyVerified, description: t("agent-config:museRepliedToAnIndependentBackgroundTest_017fdbd") },
  ];
  const checksPassed = milestones.every(item => item.done);
  const message = state.problem === "offline" ? t("agent-config:connectionUpdatesPausedRefreshToCheckTheLatest_13593cc")
    : state.problem === "disconnected" ? t("agent-config:disconnectedTheseAreTheLastObservedConnectionChecks_67e28ed")
    : state.problem === "connection_expired" ? t("agent-config:thisMuseConnectionExpiredReconnectMuseWithA_4eb23a4")
    : state.problem === "disabled" ? t("agent-config:museIsDisabledTheseAreTheLastObserved_2a677e7")
    : state.problem === "prompt_unavailable" ? t("agent-config:thisSetupPromptWasReplacedOrExpiredCreate_621c158")
    : state.problem === "agent_unavailable" ? t("agent-config:connectionChecksPassedResolveThisAgentSSetup_beac305")
    : state.problem === "no_recent_response" ? t("agent-config:noRecentResponseOpenMuseToCheckThe_bef1030")
    : state.testing ? t("agent-config:waitingForMuseToReplyToTheCurrent_0aa9bc9")
    : checksPassed && state.ready ? t("agent-config:museIsReadyForTasksAllConnectionChecks_9682589")
    : checksPassed ? t("agent-config:allConnectionChecksPassedPaperclipIsFinishingAgent_0059121")
    : !state.paired ? t("agent-config:watchingForMuseToPairCopyTheSetup_8dcd5fb")
    : !state.receiverDetected ? t("agent-config:museIsPairedWaitingForTheFirstPersisted_4e94052")
    : t("agent-config:receiverDetectedWaitingForMuseToReplyTo_e062b95");
  return <section aria-label={t("agent-config:museConnectionChecks_830be39")} className="space-y-4">
    <ol className="space-y-4">
      {milestones.map(item => <li key={item.title} className="flex items-start gap-3">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", item.done ? "bg-accent text-foreground" : "text-muted-foreground")}>
          {item.done ? <Check className="size-4" /> : <Circle className="size-4" />}
        </span>
        <div className="min-w-0 pt-0.5">
          <p className={cn("text-sm", item.done ? "font-medium" : "text-muted-foreground")}>
            {item.title}<span className="sr-only">{item.done ? t("agent-config:complete_6fbfa08") : t("agent-config:waiting_86114ea")}</span>
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
  const { t } = useTranslation("agent-config");
  const detailsId = useId();
  const muse = preset === "muse";
  const museDetails = muse && !!museDraft;
  const museAwaitingInvitation = muse && !museDetails && !museConnection && !approvalHref;
  const museReady = muse && !!museConnection?.ready && museConnection.paired && museConnection.receiverDetected && museConnection.backgroundReplyVerified && !museConnection.problem && !museConnection.testing;
  const provider = presets.find(item => item.id === preset);
  const dot = preset === "dot";
  const ready = museReady || (dot && connection.phase === "ready" && !connection.problem);
  const connecting = dot && connection.phase !== "waiting";
  const progressLabel = connection.problem === "agent_unavailable" ? t("agent-config:agentUnavailable_a289814")
    : connection.problem === "offline" ? t("agent-config:updatesPaused_bb664b7")
    : connection.problem === "event_timeout" ? t("agent-config:needsAttention_a126722")
    : connection.phase === "finishing" ? t("agent-config:finishingSetup_0744df9")
    : connection.phase === "connected" ? t("agent-config:connecting_fd3e796") : t("agent-config:confirmingConnection_434cc75");
  return <>
    <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6 pt-8 sm:px-8">
      <div className="space-y-3 pr-5">
        {muse && <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" />{t("agent-config:back_b52b36b")}</Button>}
        {provider && <AdapterMark type={provider.adapter} className="size-10" />}
        <div className="space-y-2">
          <DialogTitle className="text-xl font-semibold tracking-tight">
            {!provider ? t("agent-config:inviteAnExternalAgent_a382ae6") : muse ? ready ? t("agent-config:museIsConnected_775ef82") : museDetails || museAwaitingInvitation ? t("agent-config:inviteYourMuse_66cfdea") : t("agent-config:connectYourMuse_3b75833") : dot ? ready ? t("agent-config:yourDotIsConnected_f7120ac") : t("agent-config:connectYourDot_d7cfc6a") : preset === "hermes" ? t("agent-config:inviteYourHermesAgent_39bcd83") : t("agent-config:inviteYourAgent_b8cc88f")}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {!provider ? t("agent-config:bringAnAgentYouAlreadyUseIntoValue_c751d2a", { value1: companyName })
              : muse ? museDetails ? t("agent-config:giveYourPersonalMuseANameAndRole_e7a2880", { value1: companyName })
              : museAwaitingInvitation ? t("agent-config:museRequiresAnAuthenticatedPaperclipInstanceWithA_2fc5398")
              : ready ? t("agent-config:museCanReceiveAssignmentsAndWorkWithValue_05c56ab", { value1: companyName })
              : !prompt && !museConnection?.paired ? t("agent-config:weReCheckingWhetherThisInstanceCanPrepare_4375302")
              : t("agent-config:pasteTheSetupPromptIntoYourCurrentMuse_4e4aeb2")
              : ready ? t("agent-config:yourDotCanNowReceiveAssignmentsAndWork_45705ee", { value1: companyName })
              : connection.problem === "agent_unavailable" ? t("agent-config:yourDotIsConnectedThisAgentMustBe_7c8459a")
              : connection.phase === "finishing" ? t("agent-config:yourDotHasConnectedAndConfirmedTaskUpdates_38a423e")
              : connecting ? t("agent-config:yourDotHasConnectedWeReCheckingThat_9eb9b45")
              : dot ? t("agent-config:copyTheSetupPromptAndSendItTo_3740a4a")
              : t("agent-config:copyTheInvitationPromptAndSendItTo_4d9ab8c", { value1: preset === "hermes" ? "Hermes " : "" })}
          </DialogDescription>
        </div>
      </div>
      {error && <div role="alert" className="space-y-3 text-sm text-destructive"><p>{error}</p>{!museAwaitingInvitation && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agent-config:tryAgain_042c862")}</Button>}</div>}
      {!provider ? <><ExternalAgentPresetPicker onSelect={onSelect} dotDisabledReason={dotDisabledReason} grokDisabledReason={grokDisabledReason} museEnabled={museEnabled} />
        {dotDisabledReason && <p className="text-sm text-muted-foreground">{dotDisabledReason}</p>}{grokDisabledReason && grokDisabledReason !== dotDisabledReason && <p className="text-sm text-muted-foreground">{grokDisabledReason}</p>}</>
        : approvalHref ? <p className="text-sm text-muted-foreground">{t("agent-config:anOrganizationAdminNeedsToApproveThisAgent_a9d4d48")} {muse ? t("agent-config:muse_cf0dee2") : t("agent-config:dot_46856bf")} {t("agent-config:canConnectThisPageWillUpdateAfterApproval_b44e4af")}</p>
        : museAwaitingInvitation ? busy ? <p role="status" className="text-sm text-muted-foreground">{t("agent-config:loadingMuseInvitation_824307f")}</p> : null
        : muse && busy && !museDetails && !prompt && !museConnection?.paired ? <p role="status" className="text-sm text-muted-foreground">{t("agent-config:loadingMuseSetup_764f096")}</p>
        : museDetails ? <form id={detailsId} className="space-y-4" onSubmit={event => { event.preventDefault(); if (museDraft.name.trim() && !busy) onMuseContinue?.(); }}>
          <div className="space-y-2">
            <label htmlFor={`${detailsId}-name`} className="text-sm font-medium">{t("agent-config:agentName_fc92420")}</label>
            <Input id={`${detailsId}-name`} disabled={busy} autoFocus maxLength={100} value={museDraft.name} placeholder={t("agent-config:muse_cf0dee2")} onChange={event => onMuseDraftChange?.({ ...museDraft, name: event.target.value })} />
          </div>
          <div className="space-y-2">
            <label htmlFor={`${detailsId}-role`} className="text-sm font-medium">{t("agent-config:role_c3f104d")}</label>
            <select id={`${detailsId}-role`} disabled={busy} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={museDraft.role} onChange={event => {
              const role = AGENT_ROLES.find(value => value === event.target.value);
              if (role) onMuseDraftChange?.({ ...museDraft, role });
            }}>{AGENT_ROLES.map(role => <option key={role} value={role}>{getAgentRoleLabel(role)}</option>)}</select>
          </div>
          <p className="text-xs text-muted-foreground">{t("agent-config:museUsesItsOwnApprovedToolsProviderUsage_b5c688c")}</p>
        </form>
        : muse && museConnection ? <>
          <MuseConnectionChecks state={museConnection} />
          {museConnection.problem === "no_recent_response" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agent-config:testBackgroundReply_66e9f89")}</Button>}
          {museConnection.problem === "offline" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agent-config:refreshConnection_e260210")}</Button>}
          {!museConnection.paired && <a href="https://muse.ai" target="_blank" rel="noopener noreferrer" className="inline-flex text-sm text-foreground underline underline-offset-4">{t("agent-config:openMuse_ddc100d")}</a>}
          <p className="text-xs text-muted-foreground">{t("agent-config:receiverContactIsPersistedInBatchesAndMay_bf9d613")}</p>
        </>
        : busy && !prompt && connection.phase === "waiting" ? <p role="status" className="text-sm text-muted-foreground">{t("agent-config:preparingYourInvitation_8f9820a")}</p> : dot ? <>
        <div className="border-t pt-6"><DotConnectionChecks state={connection} />
          {connection.phase === "waiting" && <p className="mt-4 text-xs text-muted-foreground">{t("agent-config:dotUsesYourOpenaiAccountProviderUsageAnd_edf44b8")}</p>}</div>
        {connection.problem === "event_timeout" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agent-config:retryTestEvent_1b1e796")}</Button>}
        {connection.problem === "offline" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agent-config:reconnectUpdates_1b08b54")}</Button>}
      </> : <p className="text-sm leading-relaxed text-muted-foreground">{t("agent-config:theInvitationIncludesEverythingYourAgentNeedsTo_ef66b85")} {companyName}{t("agent-config:youCanReviewItsRequestBeforeGrantingAccess_8d846c2")}</p>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={muse ? onClose : provider ? onBack : onClose}>
          {provider && !muse && <ArrowLeft className="size-4" />}{muse ? ready ? t("agent-config:close_bbfa773") : t("agent-config:saveExit_fc5599f") : provider ? t("agent-config:back_b52b36b") : t("agent-config:cancel_77dfd21")}
        </Button>
      </div>
      {provider && (approvalHref ? <Button asChild><Link to={approvalHref} onClick={onClose}>{t("agent-config:reviewApproval_2ee7925")}</Link></Button>
        : museDetails ? <Button type="submit" form={detailsId} disabled={busy || !museDraft.name.trim()}>{busy ? t("agent-config:preparing_0b1d6c0") : t("agent-config:continue_2e02623")}</Button>
        : ready ? <Button onClick={onClose}>{t("agent-config:done_e9b450d")}</Button>
        : museAwaitingInvitation ? <Button disabled={busy} onClick={onRetry}>{busy ? t("agent-config:loadingSetup_42e09d4") : t("agent-config:refreshSetup_f3964b6")}</Button>
        : muse ? museConnection?.problem === "disconnected" || museConnection?.problem === "connection_expired" ? <Button disabled={busy} onClick={onNewPrompt}>{t("agent-config:reconnectMuse_5749432")}</Button>
          : museConnection?.problem === "prompt_unavailable" ? <Button disabled={busy} onClick={onNewPrompt}>{t("agent-config:createANewPrompt_fe56a96")}</Button>
          : !museConnection?.paired && prompt ? <AgentSetupPrompt key={prompt} prompt={prompt} label={t("agent-config:copySetupPrompt_c42e185")} title={t("agent-config:connectYourMuse_3b75833")} agent={{ name: t("agent-config:muse_cf0dee2"), icon: <Bot className="size-5" /> }} description={t("agent-config:sendThisWholePromptToYourCurrentMuse_2a41606")} align="end" className="min-w-0 shrink" onCopied={onCopied} />
          : busy ? <Button disabled>{t("agent-config:preparing_0b1d6c0")}</Button>
          : <Button asChild><a href="https://muse.ai" target="_blank" rel="noopener noreferrer">{t("agent-config:openMuse_ddc100d")}</a></Button>
        : connecting ? <Button disabled aria-live="polite">
          {!connection.problem && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {progressLabel}
        </Button>
        : dot && connection.problem === "prompt_unavailable" ? <Button disabled={busy} onClick={onNewPrompt}>{t("agent-config:createANewPrompt_fe56a96")}</Button>
        : !prompt || busy ? <Button disabled>{busy ? t("agent-config:preparing_0b1d6c0") : t("agent-config:waitingForDot_e2fea66")}</Button>
        : <AgentSetupPrompt
          key={preset}
          prompt={prompt}
          label={dot ? t("agent-config:copySetupPrompt_c42e185") : t("agent-config:copyInvitationPrompt_6f0c7f0")}
          title={dot ? t("agent-config:connectYourDot_d7cfc6a") : t("agent-config:inviteYourAgent_b8cc88f")}
          description={dot ? t("agent-config:sendThisWholePromptToYourDotIn_4772974") : t("agent-config:sendThisWholePromptToYourAgent_8b84b74")}
          agent={dot ? { name: t("agent-config:dot_46856bf"), src: "/brands/adapters/openai-dot.svg" } : undefined}
          align="end"
          className="min-w-0 shrink"
          onCopied={onCopied}
        />)}
    </div>
  </>;
}
