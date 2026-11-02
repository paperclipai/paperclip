import { t, useTranslation } from "@/i18n";
import { Mic, MicOff, Phone, PhoneOff, RotateCcw, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const VOICE_CONTROL_STATES = ["idle", "connecting", "listening", "speaking", "working", "interrupted", "reconnecting", "ending", "ended", "failed", "cleanup_failed"] as const;
export type VoiceControlState = typeof VOICE_CONTROL_STATES[number];
const labels = (): Record<VoiceControlState, string> => ({
  idle: t("oct19Voice.readyToTalk_xhbo8t"), connecting: t("oct19Voice.connecting_1puhp9v"), listening: t("oct19Voice.listening_89yydm"), speaking: t("oct19Voice.speaking_gsnnxz"),
  working: t("oct19Voice.workingOnYourTask_1xmtb8l"), interrupted: t("oct19Voice.listeningToYourFollowUp_y8lmab"), reconnecting: t("oct19Voice.reconnecting_d1lxms"),
  ending: t("oct19Voice.endingCall_1o8ykw0"), ended: t("oct19Voice.callEnded_1y7fdo9"), failed: t("oct19Voice.voiceConnectionUnavailable_1kcfzzx"), cleanup_failed: t("oct19Voice.callClosureUnconfirmed_1ikwnv4"),
});
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
  useTranslation();
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
    <section aria-label={t("oct19Voice.voiceWith", { name: agentName })} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="break-words text-sm font-medium">{t("oct19Voice.talkTo", { name: agentName })}</h3>
        <p role="status" className="text-sm text-muted-foreground">{labels()[state]}{muted && !inactive ? t("oct19Voice.microphoneMuted_ttic9z") : ""}</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {inactive ? (
          <Button ref={startButton} size="sm" disabled={busy} onClick={onStart}><Phone aria-hidden="true" />{state === "failed" ? t("oct19Voice.tryAgain_982hh6") : t("oct19Voice.startVoice_1h746pd")}</Button>
        ) : (
          <>
            <Button size="sm" variant="outline" aria-pressed={muted} disabled={busy || connecting || state === "ending" || state === "cleanup_failed"} onClick={onMute}>
              {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}{muted ? t("oct19Voice.unmute_1g006uz") : t("oct19Voice.mute_hl254k")}
            </Button>
            <Button size="sm" variant="outline" disabled={state === "ending"} onClick={() => { restoreFocus.current = true; onEnd(); }}><PhoneOff aria-hidden="true" />{state === "cleanup_failed" ? t("oct19Voice.retryEndingCall_4xstts") : t("oct19Voice.endCall_ac9342")}</Button>
          </>
        )}
        {canRepeat && onRepeat && !inactive && <Button size="sm" variant="outline" disabled={busy || connecting || state === "ending" || state === "cleanup_failed"} onClick={onRepeat}><RotateCcw aria-hidden="true" />{t("oct19Voice.repeatAnswer_14git0o")}</Button>}
        {playbackBlocked && !inactive && <Button size="sm" variant="outline" onClick={onResumeAudio}><Volume2 aria-hidden="true" />{t("oct19Voice.enableAudio_193a5j8")}</Button>}
      </div>
      {!inactive && <p className="text-xs text-muted-foreground">{t("oct19Voice.endingTheCallKeepsYourTask_13i37ft")}</p>}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    </section>
  );
}
