import { Mic, MicOff, Phone, PhoneOff, RotateCcw, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const VOICE_CONTROL_STATES = ["idle", "connecting", "listening", "speaking", "working", "interrupted", "reconnecting", "ending", "ended", "failed", "cleanup_failed"] as const;
export type VoiceControlState = typeof VOICE_CONTROL_STATES[number];
const labels: Record<VoiceControlState, string> = {
  idle: "Ready to talk", connecting: "Connecting…", listening: "Listening", speaking: "Speaking",
  working: "Working on your task", interrupted: "Listening to your follow-up", reconnecting: "Reconnecting…",
  ending: "Ending call…", ended: "Call ended", failed: "Voice connection unavailable", cleanup_failed: "Call closure unconfirmed",
};
export interface VoiceControlsProps {
  state: VoiceControlState;
  agentName: string;
  muted?: boolean;
  busy?: boolean;
  playbackBlocked?: boolean;
  canRepeat?: boolean;
  onRepeat?: () => void;
  error?: string;
  announcement?: string;
  onStart: () => void;
  onMute: () => void;
  onEnd: () => void;
  onResumeAudio: () => void;
  className?: string;
}
export function VoiceControls({ state, agentName, muted = false, busy = false, playbackBlocked = false, canRepeat = false, onRepeat, error, announcement, onStart, onMute, onEnd, onResumeAudio, className }: VoiceControlsProps) {
  const inactive = state === "idle" || state === "ended" || state === "failed";
  const connecting = state === "connecting" || state === "reconnecting";
  const startButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!inactive || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body) startButton.current?.focus();
  }, [inactive]);
  return (
    <section aria-label={`Voice conversation with ${agentName}`} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="break-words text-sm font-medium">Talk to {agentName}</h3>
        <p role="status" className="text-sm text-muted-foreground">{labels[state]}{muted && !inactive ? " · Microphone muted" : ""}</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {inactive ? (
          <Button ref={startButton} size="sm" disabled={busy} onClick={onStart}><Phone aria-hidden="true" />{state === "failed" ? "Try again" : "Start voice"}</Button>
        ) : (
          <>
            <Button size="sm" variant="outline" aria-pressed={muted} disabled={busy || connecting || state === "ending" || state === "cleanup_failed"} onClick={onMute}>
              {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}{muted ? "Unmute" : "Mute"}
            </Button>
            <Button size="sm" variant="outline" disabled={state === "ending"} onClick={() => { restoreFocus.current = true; onEnd(); }}><PhoneOff aria-hidden="true" />{state === "cleanup_failed" ? "Retry ending call" : "End call"}</Button>
          </>
        )}
        {canRepeat && onRepeat && !inactive && <Button size="sm" variant="outline" disabled={busy || connecting || state === "ending" || state === "cleanup_failed"} onClick={onRepeat}><RotateCcw aria-hidden="true" />Repeat answer</Button>}
        {playbackBlocked && !inactive && <Button size="sm" variant="outline" onClick={onResumeAudio}><Volume2 aria-hidden="true" />Enable audio</Button>}
      </div>
      {!inactive && <p className="text-xs text-muted-foreground">Ending the call keeps your task running. Speko voice charges are separate from agent costs.</p>}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    </section>
  );
}
