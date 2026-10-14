import { useEffect, useState } from "react";
import { Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { Agents } from "@/pages/Agents";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { AgentBasicsDialog } from "@/components/new-agent/AgentBasicsDialog";
import { ExternalAgentInviteContent, type DotConnectionState, type ExternalAgentPreset } from "@/components/new-agent/ExternalAgentInviteContent";
import { Dialog } from "@/components/ui/dialog";
import { AnimatedDialogContent } from "@/components/AnimatedDialogContent";
import { Button } from "@/components/ui/button";
import { dotInvitePrompt, externalInvitePrompt } from "./fixtures";

export interface ExternalAgentInvitePreviewProps {
  initialScreen?: "entry" | "picker" | "setup";
  initialPreset?: ExternalAgentPreset;
  initialConnection?: DotConnectionState;
  companyName?: string;
  simulate?: boolean;
  failTest?: boolean;
  stepDelayMs?: number;
  shell?: boolean;
  preparing?: boolean;
}

/** Storybook owns simulation. No timer, fixture code, or fake status ships in the UI component. */
export function ExternalAgentInvitePreview({
  initialScreen = "entry", initialPreset = "dot", initialConnection = { phase: "waiting" },
  companyName = "Paperclip", simulate = true, failTest = false, stepDelayMs = 2000, shell = true, preparing = false,
}: ExternalAgentInvitePreviewProps) {
  const [screen, setScreen] = useState<"entry" | "picker" | "setup" | "closed">(initialScreen);
  const [preset, setPreset] = useState<ExternalAgentPreset>(initialPreset);
  const [connection, setConnection] = useState(initialConnection);
  const [watching, setWatching] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [generation, setGeneration] = useState(1);
  useEffect(() => {
    if (!simulate || !watching || connection.problem || connection.phase === "ready") return;
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
          prompt={preparing ? "" : preset === "dot" ? dotInvitePrompt(generation) : externalInvitePrompt}
          connection={connection}
          onSelect={value => { setPreset(value); setScreen("setup"); }}
          onBack={() => setScreen("picker")}
          onClose={() => setScreen("closed")}
          onCopied={() => { if (preset === "dot") setWatching(true); }}
          onRetry={() => { setConnection(previous => ({ phase: previous.phase })); setRetrying(true); setWatching(true); }}
          onNewPrompt={() => { setGeneration(value => value + 1); setConnection({ phase: "waiting" }); setWatching(false); }}
        />
      </AnimatedDialogContent>
    </Dialog>
  </>;
}
