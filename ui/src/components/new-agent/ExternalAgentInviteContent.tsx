import { Link } from "@/lib/router";
import { ArrowLeft, Check, Circle, CircleAlert, Loader2 } from "lucide-react";
import { AdapterMark } from "../AdapterMark";
import { AgentSetupPrompt } from "../AgentSetupPrompt";
import { Button } from "../ui/button";
import { DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "@/lib/utils";

export type ExternalAgentPreset = "dot" | "hermes" | "other";
export type DotConnectionState = {
  phase: "waiting" | "connected" | "subscribed" | "testing" | "ready";
  problem?: "event_timeout" | "prompt_unavailable" | "offline";
};

const presets = [
  { id: "dot", name: "Dot", adapter: "openai_dot", description: "Your Dot in ChatGPT" },
  { id: "hermes", name: "Hermes", adapter: "hermes_gateway", description: "An existing Hermes agent" },
  { id: "other", name: "Other", adapter: "http", description: "Any agent that can connect to Paperclip" },
] as const;

export function ExternalAgentPresetPicker({ onSelect, dotDisabledReason }: { onSelect: (preset: ExternalAgentPreset) => void; dotDisabledReason?: string }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
    {presets.map(preset => <button
      key={preset.id}
      type="button"
      onClick={() => onSelect(preset.id)}
      disabled={preset.id === "dot" && !!dotDisabledReason}
      title={preset.id === "dot" ? dotDisabledReason : undefined}
      className="flex aspect-square flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-3 py-4 text-center transition-colors disabled:opacity-50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AdapterMark type={preset.adapter} className="size-8" />
      <span className="text-sm font-medium">{preset.name}</span>
      <span className="sr-only">{preset.description}</span>
    </button>)}
  </div>;
}

const checks = [
  { title: "Connected to Paperclip", description: "Your Dot has connected to this agent." },
  { title: "Task updates enabled", description: "Your Dot is subscribed to new assignments and messages." },
  { title: "Test event confirmed", description: "Your Dot received our test and replied to Paperclip." },
];

/** Controlled by server evidence in the invite controller, never by copying a prompt. */
export function DotConnectionChecks({ state }: { state: DotConnectionState }) {
  const completed = { waiting: 0, connected: 1, subscribed: 2, testing: 2, ready: 3 }[state.phase];
  const message = state.problem === "offline" ? "Connection updates paused. Reconnect to check the latest status."
    : state.problem === "prompt_unavailable" ? "This setup prompt was replaced in another window. Create a fresh prompt to continue."
    : state.problem === "event_timeout" ? "Your Dot connected, but hasn’t confirmed the test event. Ask it to check Paperclip, then retry."
    : state.phase === "ready" ? "Your Dot is ready for tasks. Messages can travel both ways."
    : state.phase === "waiting" ? "Watching for your Dot. Updates will appear here automatically."
    : state.phase === "connected" ? "Your Dot connected. Waiting for it to enable task updates."
    : "Waiting for your Dot to confirm a test event. No task will be created.";
  return <section aria-label="Dot connection checks" className="space-y-4">
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
              {check.title}<span className="sr-only">{done ? ": complete" : failed ? ": needs attention" : active ? ": in progress" : ": waiting"}</span>
            </p>
            {done && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{check.description}</p>}
          </div>
        </li>;
      })}
    </ol>
    <p role={state.problem && state.problem !== "prompt_unavailable" ? "alert" : "status"} aria-live="polite" className={cn("text-sm leading-relaxed", state.problem && state.problem !== "prompt_unavailable" ? "text-destructive" : "text-muted-foreground")}>{message}</p>
  </section>;
}

/** Shared presentation for the invitation flow. The caller owns invitations and watching. */
export function ExternalAgentInviteContent({
  preset, prompt, companyName, connection, onSelect, onBack, onClose, onCopied, onRetry, onNewPrompt,
  dotDisabledReason, busy = false, error, approvalHref,
}: {
  dotDisabledReason?: string;
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
  const provider = presets.find(item => item.id === preset);
  const dot = preset === "dot";
  const ready = dot && connection.phase === "ready" && !connection.problem;
  const connecting = dot && connection.phase !== "waiting";
  const progressLabel = connection.problem === "offline" ? "Updates paused"
    : connection.problem === "event_timeout" ? "Needs attention"
    : connection.phase === "connected" ? "Connecting…" : "Confirming connection…";
  return <>
    <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6 pt-8 sm:px-8">
      <div className="space-y-3 pr-5">
        {provider && <AdapterMark type={provider.adapter} className="size-10" />}
        <div className="space-y-2">
          <DialogTitle className="text-xl font-semibold tracking-tight">
            {!provider ? "Invite an external agent" : dot ? ready ? "Your Dot is connected" : "Connect your Dot" : preset === "hermes" ? "Invite your Hermes agent" : "Invite your agent"}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {!provider ? `Bring an agent you already use into ${companyName}.`
              : ready ? `Your Dot can now receive assignments and work with ${companyName}.`
              : connecting ? "Your Dot has connected. We’re checking that task updates can travel both ways."
              : dot ? "Copy the setup prompt and send it to your Dot in ChatGPT. Your Dot will connect itself; we’ll watch for it here."
              : `Copy the invitation prompt and send it to your ${preset === "hermes" ? "Hermes " : ""}agent. Approve its join request in Paperclip when it’s ready.`}
          </DialogDescription>
        </div>
      </div>
      {error && <div role="alert" className="space-y-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" disabled={busy} onClick={onRetry}>Try again</Button></div>}
      {!provider ? <><ExternalAgentPresetPicker onSelect={onSelect} dotDisabledReason={dotDisabledReason} />
        {dotDisabledReason && <p className="text-sm text-muted-foreground">{dotDisabledReason}</p>}</>
        : approvalHref ? <p className="text-sm text-muted-foreground">An organization admin needs to approve this agent before Dot can connect. This page will update after approval.</p>
        : busy && !prompt && connection.phase === "waiting" ? <p role="status" className="text-sm text-muted-foreground">Preparing your invitation…</p> : dot ? <>
        <div className="border-t pt-6"><DotConnectionChecks state={connection} />
          {connection.phase === "waiting" && <p className="mt-4 text-xs text-muted-foreground">Dot uses your OpenAI account. Provider usage and cost aren’t reported to Paperclip.</p>}</div>
        {connection.problem === "event_timeout" && <Button variant="outline" disabled={busy} onClick={onRetry}>Retry test event</Button>}
        {connection.problem === "offline" && <Button variant="outline" disabled={busy} onClick={onRetry}>Reconnect updates</Button>}
      </> : <p className="text-sm leading-relaxed text-muted-foreground">The invitation includes everything your agent needs to join {companyName}. You can review its request before granting access.</p>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <Button variant="ghost" onClick={provider ? onBack : onClose}>
        {provider && <ArrowLeft className="size-4" />}{provider ? "Back" : "Cancel"}
      </Button>
      {provider && (approvalHref ? <Button asChild><Link to={approvalHref} onClick={onClose}>Review approval</Link></Button>
        : ready ? <Button onClick={onClose}>Done</Button>
        : connecting ? <Button disabled aria-live="polite">
          {!connection.problem && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {progressLabel}
        </Button>
        : dot && connection.problem === "prompt_unavailable" ? <Button disabled={busy} onClick={onNewPrompt}>Create a new prompt</Button>
        : !prompt || busy ? <Button disabled>{busy ? "Preparing…" : "Waiting for Dot…"}</Button>
        : <AgentSetupPrompt
          key={preset}
          prompt={prompt}
          label={dot ? "Copy setup prompt" : "Copy invitation prompt"}
          title={dot ? "Connect your Dot" : "Invite your agent"}
          description={dot ? "Send this whole prompt to your Dot in ChatGPT." : "Send this whole prompt to your agent."}
          agent={dot ? { name: "Dot", src: "/brands/adapters/openai-dot.svg" } : undefined}
          align="end"
          className="min-w-0 shrink"
          onCopied={onCopied}
        />)}
    </div>
  </>;
}
