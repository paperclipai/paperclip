import { useEffect, useState } from "react";
import { Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { Agents } from "@/pages/Agents";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { AgentBasicsDialog } from "@/components/new-agent/AgentBasicsDialog";
import { ExternalAgentInviteContent, type DotConnectionState, type ExternalAgentPreset, type MuseConnectionState } from "@/components/new-agent/ExternalAgentInviteContent";
import { Dialog } from "@/components/ui/dialog";
import { AnimatedDialogContent } from "@/components/AnimatedDialogContent";
import { Button } from "@/components/ui/button";
import { musePairing } from "./muse-fixtures";
import type { MuseInvitationDraft } from "@/lib/muse-invitation-draft";
import { dotInvitePrompt, externalInvitePrompt } from "./fixtures";

export interface ExternalAgentInvitePreviewProps {
  initialScreen?: "entry" | "picker" | "setup";
  initialPreset?: ExternalAgentPreset;
  initialConnection?: DotConnectionState;
  initialMuseConnection?: MuseConnectionState;
  museDetails?: boolean;
  museEnabled?: boolean;
  pendingApproval?: boolean;
  companyName?: string;
  simulate?: boolean;
  failTest?: boolean;
  stepDelayMs?: number;
  shell?: boolean;
  preparing?: boolean;
  invitationUnavailable?: boolean;
  error?: string;
}

/** Storybook owns simulation. No timer, fixture code, or fake status ships in the UI component. */
export function ExternalAgentInvitePreview({
  initialScreen = "entry", initialPreset = "dot", initialConnection = { phase: "waiting" },
  initialMuseConnection = { paired: false, receiverDetected: false, backgroundReplyVerified: false, ready: false },
  museDetails = false, museEnabled = false, pendingApproval = false,
  companyName = "Paperclip", simulate = true, failTest = false, stepDelayMs = 2000, shell = true, preparing = false, invitationUnavailable = false, error,
}: ExternalAgentInvitePreviewProps) {
  const [screen, setScreen] = useState<"entry" | "picker" | "setup" | "closed">(initialScreen);
  const [preset, setPreset] = useState<ExternalAgentPreset>(initialPreset);
  const [connection, setConnection] = useState(initialConnection);
  const [museConnection, setMuseConnection] = useState(initialMuseConnection);
  const [museDraft, setMuseDraft] = useState<MuseInvitationDraft | undefined>(museDetails ? { name: "Maia", role: "researcher" } : undefined);
  const [watching, setWatching] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [generation, setGeneration] = useState(1);
  useEffect(() => {
    if (preset !== "muse" || !simulate || !watching || museConnection.problem || museConnection.ready) return;
    const timer = window.setTimeout(() => setMuseConnection(previous => !previous.paired ? { ...previous, paired: true }
      : !previous.receiverDetected ? { ...previous, receiverDetected: true }
      : !previous.backgroundReplyVerified ? { ...previous, backgroundReplyVerified: true, finishing: true }
      : { ...previous, finishing: false, ready: true }), stepDelayMs);
    return () => window.clearTimeout(timer);
  }, [preset, simulate, watching, museConnection, stepDelayMs]);
  useEffect(() => {
    if (preset === "muse" || !simulate || !watching || connection.problem || connection.phase === "ready") return;
    const phase = connection.phase;
    const next = { waiting: "connected", connected: "subscribed", subscribed: "testing", testing: "finishing", finishing: "ready" } as const;
    const timer = window.setTimeout(() => {
      setConnection(phase === "testing" && failTest && !retrying
        ? { phase, problem: "event_timeout" } : { phase: next[phase] });
    }, stepDelayMs);
    return () => window.clearTimeout(timer);
  }, [connection, watching, simulate, stepDelayMs, failTest, retrying]);
  return <>
    {shell ? <PluginLauncherProvider>
      <Routes><Route path="/:companyPrefix" element={<Layout />}><Route path="agents" element={<Agents />} /></Route></Routes>
    </PluginLauncherProvider> : <div className="p-6"><Button onClick={() => setScreen("picker")}>Invite an external agent</Button></div>}
    <AgentBasicsDialog open={screen === "entry"} onClose={() => setScreen("closed")} onContinue={() => setScreen("closed")} onInvite={() => setScreen("picker")} />
    <Dialog open={screen === "picker" || screen === "setup"} onOpenChange={open => { if (!open) setScreen("closed"); }}>
      <AnimatedDialogContent className="flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-(--sz-560px)">
        <ExternalAgentInviteContent
          preset={screen === "picker" ? null : preset}
          companyName={companyName}
          busy={preparing}
          error={error}
          prompt={preparing || invitationUnavailable ? "" : preset === "muse" ? musePairing.setupInstruction : preset === "dot" ? dotInvitePrompt(generation) : externalInvitePrompt}
          museEnabled={museEnabled}
          museConnection={invitationUnavailable ? undefined : museConnection}
          museDraft={museDraft}
          onMuseDraftChange={setMuseDraft}
          onMuseContinue={() => setMuseDraft(undefined)}
          approvalHref={pendingApproval ? "/approvals/example-muse-hire" : undefined}
          connection={connection}
          onSelect={value => { setPreset(value); if (value === "muse") setMuseDraft({ name: "", role: "general" }); setScreen("setup"); }}
          onBack={() => setScreen("picker")}
          onClose={() => setScreen("closed")}
          onCopied={() => { if (preset === "dot" || preset === "muse") setWatching(true); }}
          onRetry={() => { setMuseConnection(previous => ({ ...previous, problem: undefined })); setConnection(previous => ({ phase: previous.phase })); setRetrying(true); setWatching(true); }}
          onNewPrompt={() => { setMuseConnection({ paired: false, receiverDetected: false, backgroundReplyVerified: false, ready: false }); setGeneration(value => value + 1); setConnection({ phase: "waiting" }); setWatching(false); }}
        />
      </AnimatedDialogContent>
    </Dialog>
  </>;
}
