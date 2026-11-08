import { useId } from "react";
import { AGENT_ROLES, AGENT_ROLE_LABELS } from "@paperclipai/shared";
import type { MuseInvitationDraft } from "@/lib/muse-invitation-draft";
import { Input } from "../ui/input";
import { Link } from "@/lib/router";
import { ArrowLeft, Bot, Check, Circle, CircleAlert, Loader2 } from "lucide-react";
import { AdapterMark } from "../AdapterMark";
import { AgentSetupPrompt } from "../AgentSetupPrompt";
import { Button } from "../ui/button";
import { DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";

export type ExternalAgentPreset = "dot" | "grok_bot" | "muse" | "hermes" | "other";
export type DotConnectionState = {
  phase: "waiting" | "connected" | "subscribed" | "testing" | "finishing" | "ready";
  problem?: "event_timeout" | "prompt_unavailable" | "offline" | "agent_unavailable";
};

const presets = [
  { id: "dot", nameKey: "agents.ExternalAgentPresetPicker.dotName", adapter: "openai_dot", descriptionKey: "agents.ExternalAgentPresetPicker.dotDescription" },
  { id: "grok_bot", nameKey: "agents.ExternalAgentPresetPicker.grokName", adapter: "grok_bot", descriptionKey: "agents.ExternalAgentPresetPicker.grokDescription" },
  { id: "muse", nameKey: "agents.ExternalAgentPresetPicker.museName", adapter: "muse", descriptionKey: "agents.ExternalAgentPresetPicker.museDescription" },
  { id: "hermes", nameKey: "agents.ExternalAgentPresetPicker.hermesName", adapter: "hermes_gateway", descriptionKey: "agents.ExternalAgentPresetPicker.hermesDescription" },
  { id: "other", nameKey: "agents.ExternalAgentPresetPicker.otherName", adapter: "http", descriptionKey: "agents.ExternalAgentPresetPicker.otherDescription" },
] as const;

export function ExternalAgentPresetPicker({ onSelect, dotDisabledReason, grokDisabledReason, museEnabled = false }: { onSelect: (preset: ExternalAgentPreset) => void; dotDisabledReason?: string; grokDisabledReason?: string; museEnabled?: boolean }) {
  const { t } = useTranslation();
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
      <span className="text-sm font-medium">{t(preset.nameKey)}</span>
      <span className="sr-only">{t(preset.descriptionKey)}</span>
    </button>)}
  </div>;
}

const checks = [
  { titleKey: "agents.DotConnectionChecks.connectedTitle", descriptionKey: "agents.DotConnectionChecks.connectedDescription" },
  { titleKey: "agents.DotConnectionChecks.tasksTitle", descriptionKey: "agents.DotConnectionChecks.tasksDescription" },
  { titleKey: "agents.DotConnectionChecks.testTitle", descriptionKey: "agents.DotConnectionChecks.testDescription" },
];

/** Controlled by server evidence in the invite controller, never by copying a prompt. */
export function DotConnectionChecks({ state }: { state: DotConnectionState }) {
  const { t } = useTranslation();
  const completed = { waiting: 0, connected: 1, subscribed: 2, testing: 2, finishing: 3, ready: 3 }[state.phase];
  const message = state.problem === "agent_unavailable" ? t("agents.DotConnectionChecks.agentUnavailable")
    : state.problem === "offline" ? t("agents.DotConnectionChecks.offline")
    : state.problem === "prompt_unavailable" ? t("agents.DotConnectionChecks.promptUnavailable")
    : state.problem === "event_timeout" ? t("agents.DotConnectionChecks.eventTimeout")
    : state.phase === "finishing" ? t("agents.DotConnectionChecks.finishing")
    : state.phase === "ready" ? t("agents.DotConnectionChecks.ready")
    : state.phase === "waiting" ? t("agents.DotConnectionChecks.watching")
    : state.phase === "connected" ? t("agents.DotConnectionChecks.connected")
    : t("agents.DotConnectionChecks.waitingEvent");
  return <section aria-label={t("agents.DotConnectionChecks.ariaLabel")} className="space-y-4">
    <ol className="space-y-4">
      {checks.map((check, index) => {
        const done = index < completed;
        const failed = index === completed && state.problem === "event_timeout";
        const active = index === completed && !state.problem;
        const Icon = done ? Check : failed ? CircleAlert : active ? Loader2 : Circle;
        return <li key={check.titleKey} className="flex items-start gap-3" aria-current={active ? "step" : undefined}>
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", done ? "bg-accent text-foreground" : failed ? "text-destructive" : "text-muted-foreground")}>
            <Icon className={cn("size-4", active && "animate-spin motion-reduce:animate-none")} />
          </span>
          <div className="min-w-0 pt-0.5">
            <p className={cn("text-sm", done || active || failed ? "font-medium" : "text-muted-foreground")}>
              {t(check.titleKey)}<span className="sr-only">{done ? t("agents.DotConnectionChecks.srComplete") : failed ? t("agents.DotConnectionChecks.srNeedsAttention") : active ? t("agents.DotConnectionChecks.srInProgress") : t("agents.DotConnectionChecks.srWaiting")}</span>
            </p>
            {done && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(check.descriptionKey)}</p>}
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
  const { t } = useTranslation();
  const milestones = [
    { title: t("agents.MuseConnectionChecks.pairedTitle"), done: state.paired, description: t("agents.MuseConnectionChecks.pairedDescription") },
    { title: t("agents.MuseConnectionChecks.receiverTitle"), done: state.receiverDetected, description: t("agents.MuseConnectionChecks.receiverDescription") },
    { title: t("agents.MuseConnectionChecks.backgroundTitle"), done: state.backgroundReplyVerified, description: t("agents.MuseConnectionChecks.backgroundDescription") },
  ];
  const checksPassed = milestones.every(item => item.done);
  const message = state.problem === "offline" ? t("agents.MuseConnectionChecks.offline")
    : state.problem === "disconnected" ? t("agents.MuseConnectionChecks.disconnected")
    : state.problem === "connection_expired" ? t("agents.MuseConnectionChecks.connectionExpired")
    : state.problem === "disabled" ? t("agents.MuseConnectionChecks.disabled")
    : state.problem === "prompt_unavailable" ? t("agents.MuseConnectionChecks.promptUnavailable")
    : state.problem === "agent_unavailable" ? t("agents.MuseConnectionChecks.agentUnavailable")
    : state.problem === "no_recent_response" ? t("agents.MuseConnectionChecks.noRecentResponse")
    : state.testing ? t("agents.MuseConnectionChecks.testing")
    : checksPassed && state.ready ? t("agents.MuseConnectionChecks.readyTasks")
    : checksPassed ? t("agents.MuseConnectionChecks.finishingSetup")
    : !state.paired ? t("agents.MuseConnectionChecks.watchingPair")
    : !state.receiverDetected ? t("agents.MuseConnectionChecks.receiverWaiting")
    : t("agents.MuseConnectionChecks.receiverDetectedWaiting");
  return <section aria-label={t("agents.MuseConnectionChecks.ariaLabel")} className="space-y-4">
    <ol className="space-y-4">
      {milestones.map(item => <li key={item.title} className="flex items-start gap-3">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", item.done ? "bg-accent text-foreground" : "text-muted-foreground")}>
          {item.done ? <Check className="size-4" /> : <Circle className="size-4" />}
        </span>
        <div className="min-w-0 pt-0.5">
          <p className={cn("text-sm", item.done ? "font-medium" : "text-muted-foreground")}>
            {item.title}<span className="sr-only">{item.done ? t("agents.MuseConnectionChecks.srComplete") : t("agents.MuseConnectionChecks.srWaiting")}</span>
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
  const { t } = useTranslation();
  const detailsId = useId();
  const muse = preset === "muse";
  const museDetails = muse && !!museDraft;
  const museAwaitingInvitation = muse && !museDetails && !museConnection && !approvalHref;
  const museReady = muse && !!museConnection?.ready && museConnection.paired && museConnection.receiverDetected && museConnection.backgroundReplyVerified && !museConnection.problem && !museConnection.testing;
  const provider = presets.find(item => item.id === preset);
  const dot = preset === "dot";
  const ready = museReady || (dot && connection.phase === "ready" && !connection.problem);
  const connecting = dot && connection.phase !== "waiting";
  const progressLabel = connection.problem === "agent_unavailable" ? t("agents.ExternalAgentInviteContent.agentUnavailableLabel")
    : connection.problem === "offline" ? t("agents.ExternalAgentInviteContent.updatesPaused")
    : connection.problem === "event_timeout" ? t("agents.ExternalAgentInviteContent.needsAttention")
    : connection.phase === "finishing" ? t("agents.ExternalAgentInviteContent.finishingSetupLabel")
    : connection.phase === "connected" ? t("agents.ExternalAgentInviteContent.connectingLabel") : t("agents.ExternalAgentInviteContent.confirmingConnection");
  return <>
    <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6 pt-8 sm:px-8">
      <div className="space-y-3 pr-5">
        {muse && <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" />{t("agents.ExternalAgentInviteContent.back")}</Button>}
        {provider && <AdapterMark type={provider.adapter} className="size-10" />}
        <div className="space-y-2">
          <DialogTitle className="text-xl font-semibold tracking-tight">
            {!provider ? t("agents.ExternalAgentInviteContent.inviteExternalTitle") : muse ? ready ? t("agents.ExternalAgentInviteContent.museConnected") : museDetails || museAwaitingInvitation ? t("agents.ExternalAgentInviteContent.inviteMuse") : t("agents.ExternalAgentInviteContent.connectMuse") : dot ? ready ? t("agents.ExternalAgentInviteContent.dotConnected") : t("agents.ExternalAgentInviteContent.connectDot") : preset === "hermes" ? t("agents.ExternalAgentInviteContent.inviteHermes") : t("agents.ExternalAgentInviteContent.inviteAgent")}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {!provider ? t("agents.ExternalAgentInviteContent.bringAgent", { companyName })
              : muse ? museDetails ? t("agents.ExternalAgentInviteContent.giveMuseName", { companyName })
              : museAwaitingInvitation ? t("agents.ExternalAgentInviteContent.museRequires")
              : ready ? t("agents.ExternalAgentInviteContent.museReadyDesc", { companyName })
              : !prompt && !museConnection?.paired ? t("agents.ExternalAgentInviteContent.checkingMuseSetup")
              : t("agents.ExternalAgentInviteContent.pasteMusePrompt")
              : ready ? t("agents.ExternalAgentInviteContent.dotReadyDesc", { companyName })
              : connection.problem === "agent_unavailable" ? t("agents.ExternalAgentInviteContent.dotAgentUnavailable")
              : connection.phase === "finishing" ? t("agents.ExternalAgentInviteContent.dotFinishing")
              : connecting ? t("agents.ExternalAgentInviteContent.dotConnecting")
              : dot ? t("agents.ExternalAgentInviteContent.dotCopyPrompt")
              : preset === "hermes" ? t("agents.ExternalAgentInviteContent.inviteHermesPrompt") : t("agents.ExternalAgentInviteContent.inviteAgentPrompt")}
          </DialogDescription>
        </div>
      </div>
      {error && <div role="alert" className="space-y-3 text-sm text-destructive"><p>{error}</p>{!museAwaitingInvitation && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agents.ExternalAgentInviteContent.tryAgain")}</Button>}</div>}
      {!provider ? <><ExternalAgentPresetPicker onSelect={onSelect} dotDisabledReason={dotDisabledReason} grokDisabledReason={grokDisabledReason} museEnabled={museEnabled} />
        {dotDisabledReason && <p className="text-sm text-muted-foreground">{dotDisabledReason}</p>}{grokDisabledReason && grokDisabledReason !== dotDisabledReason && <p className="text-sm text-muted-foreground">{grokDisabledReason}</p>}</>
        : approvalHref ? <p className="text-sm text-muted-foreground">{t("agents.ExternalAgentInviteContent.approvalNeeded", { agent: muse ? "Muse" : "Dot" })}</p>
        : museAwaitingInvitation ? busy ? <p role="status" className="text-sm text-muted-foreground">{t("agents.ExternalAgentInviteContent.loadingInvitation")}</p> : null
        : muse && busy && !museDetails && !prompt && !museConnection?.paired ? <p role="status" className="text-sm text-muted-foreground">{t("agents.ExternalAgentInviteContent.loadingSetup")}</p>
        : museDetails ? <form id={detailsId} className="space-y-4" onSubmit={event => { event.preventDefault(); if (museDraft.name.trim() && !busy) onMuseContinue?.(); }}>
          <div className="space-y-2">
            <label htmlFor={`${detailsId}-name`} className="text-sm font-medium">{t("agents.ExternalAgentInviteContent.agentName")}</label>
            <Input id={`${detailsId}-name`} disabled={busy} autoFocus maxLength={100} value={museDraft.name} placeholder="Muse" onChange={event => onMuseDraftChange?.({ ...museDraft, name: event.target.value })} />
          </div>
          <div className="space-y-2">
            <label htmlFor={`${detailsId}-role`} className="text-sm font-medium">{t("agents.ExternalAgentInviteContent.role")}</label>
            <select id={`${detailsId}-role`} disabled={busy} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={museDraft.role} onChange={event => {
              const role = AGENT_ROLES.find(value => value === event.target.value);
              if (role) onMuseDraftChange?.({ ...museDraft, role });
            }}>{AGENT_ROLES.map(role => <option key={role} value={role}>{AGENT_ROLE_LABELS[role]}</option>)}</select>
          </div>
          <p className="text-xs text-muted-foreground">{t("agents.ExternalAgentInviteContent.museTools")}</p>
        </form>
        : muse && museConnection ? <>
          <MuseConnectionChecks state={museConnection} />
          {museConnection.problem === "no_recent_response" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agents.ExternalAgentInviteContent.testBackgroundReply")}</Button>}
          {museConnection.problem === "offline" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agents.ExternalAgentInviteContent.refreshConnection")}</Button>}
          {!museConnection.paired && <a href="https://muse.ai" target="_blank" rel="noopener noreferrer" className="inline-flex text-sm text-foreground underline underline-offset-4">{t("agents.ExternalAgentInviteContent.openMuse")}</a>}
          <p className="text-xs text-muted-foreground">{t("agents.ExternalAgentInviteContent.receiverPersisted")}</p>
        </>
        : busy && !prompt && connection.phase === "waiting" ? <p role="status" className="text-sm text-muted-foreground">{t("agents.ExternalAgentInviteContent.preparingInvitation")}</p> : dot ? <>
        <div className="border-t pt-6"><DotConnectionChecks state={connection} />
          {connection.phase === "waiting" && <p className="mt-4 text-xs text-muted-foreground">{t("agents.ExternalAgentInviteContent.dotOpenAi")}</p>}</div>
        {connection.problem === "event_timeout" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agents.ExternalAgentInviteContent.retryTestEvent")}</Button>}
        {connection.problem === "offline" && <Button variant="outline" disabled={busy} onClick={onRetry}>{t("agents.ExternalAgentInviteContent.reconnectUpdates")}</Button>}
      </> : <p className="text-sm leading-relaxed text-muted-foreground">{t("agents.ExternalAgentInviteContent.invitationIncludes", { companyName })}</p>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={muse ? onClose : provider ? onBack : onClose}>
          {provider && !muse && <ArrowLeft className="size-4" />}{muse ? ready ? t("agents.ExternalAgentInviteContent.close") : t("agents.ExternalAgentInviteContent.saveExit") : provider ? t("agents.ExternalAgentInviteContent.back") : t("agents.ExternalAgentInviteContent.cancel")}
        </Button>
      </div>
      {provider && (approvalHref ? <Button asChild><Link to={approvalHref} onClick={onClose}>{t("agents.ExternalAgentInviteContent.reviewApproval")}</Link></Button>
        : museDetails ? <Button type="submit" form={detailsId} disabled={busy || !museDraft.name.trim()}>{busy ? t("agents.ExternalAgentInviteContent.preparing") : t("agents.ExternalAgentInviteContent.continue")}</Button>
        : ready ? <Button onClick={onClose}>{t("agents.ExternalAgentInviteContent.done")}</Button>
        : museAwaitingInvitation ? <Button disabled={busy} onClick={onRetry}>{busy ? t("agents.ExternalAgentInviteContent.loadingSetupBtn") : t("agents.ExternalAgentInviteContent.refreshSetup")}</Button>
        : muse ? museConnection?.problem === "disconnected" || museConnection?.problem === "connection_expired" ? <Button disabled={busy} onClick={onNewPrompt}>{t("agents.ExternalAgentInviteContent.reconnectMuseBtn")}</Button>
          : museConnection?.problem === "prompt_unavailable" ? <Button disabled={busy} onClick={onNewPrompt}>{t("agents.ExternalAgentInviteContent.createNewPrompt")}</Button>
          : !museConnection?.paired && prompt ? <AgentSetupPrompt key={prompt} prompt={prompt} label={t("agents.ExternalAgentInviteContent.copySetupPrompt")} title={t("agents.ExternalAgentInviteContent.connectMuse")} agent={{ name: "Muse", icon: <Bot className="size-5" /> }} description={t("agents.ExternalAgentInviteContent.museSendPrompt")} align="end" className="min-w-0 shrink" onCopied={onCopied} />
          : busy ? <Button disabled>{t("agents.ExternalAgentInviteContent.preparing")}</Button>
          : <Button asChild><a href="https://muse.ai" target="_blank" rel="noopener noreferrer">{t("agents.ExternalAgentInviteContent.openMuse")}</a></Button>
        : connecting ? <Button disabled aria-live="polite">
          {!connection.problem && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {progressLabel}
        </Button>
        : dot && connection.problem === "prompt_unavailable" ? <Button disabled={busy} onClick={onNewPrompt}>{t("agents.ExternalAgentInviteContent.createNewPrompt")}</Button>
        : !prompt || busy ? <Button disabled>{busy ? t("agents.ExternalAgentInviteContent.preparing") : t("agents.ExternalAgentInviteContent.waitingForDot")}</Button>
        : <AgentSetupPrompt
          key={preset}
          prompt={prompt}
          label={dot ? t("agents.ExternalAgentInviteContent.copySetupPrompt") : t("agents.ExternalAgentInviteContent.copyInvitationPrompt")}
          title={dot ? t("agents.ExternalAgentInviteContent.connectDot") : t("agents.ExternalAgentInviteContent.inviteAgent")}
          description={dot ? t("agents.ExternalAgentInviteContent.sendDotPrompt") : t("agents.ExternalAgentInviteContent.sendAgentPrompt")}
          agent={dot ? { name: "Dot", src: "/brands/adapters/openai-dot.svg" } : undefined}
          align="end"
          className="min-w-0 shrink"
          onCopied={onCopied}
        />)}
    </div>
  </>;
}
