import { useTranslation, t as translate } from "@/i18n";
import { Mic, MicOff, Phone, PhoneOff, RotateCcw, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const VOICE_CONTROL_STATES = ["idle", "connecting", "listening", "speaking", "working", "interrupted", "reconnecting", "ending", "ended", "failed", "cleanup_failed"] as const;
export type VoiceControlState = typeof VOICE_CONTROL_STATES[number];
const labels: Record<VoiceControlState, string> = {
  get idle() { return translate("connections:ready_to_talk_0348c58"); }, get connecting() { return translate("connections:connecting_fd3e796"); }, get listening() { return translate("connections:listening_dc35348"); }, get speaking() { return translate("connections:speaking_a771fe6"); },
  get working() { return translate("connections:working_on_your_task_7636ecc"); }, get interrupted() { return translate("connections:listening_to_your_follow_up_6654616"); }, get reconnecting() { return translate("connections:reconnecting_8a8b956"); },
  get ending() { return translate("connections:ending_call_a578815"); }, get ended() { return translate("connections:call_ended_9933a46"); }, get failed() { return translate("connections:voice_connection_unavailable_36bed9a"); }, get cleanup_failed() { return translate("connections:call_closure_unconfirmed_90a1aa2"); },
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
  const { t } = useTranslation("connections");
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
    <section aria-label={t("voice_conversation_with_f82db7d", { agentName: agentName })} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="break-words text-sm font-medium">{t("talk_to_4384f23", { agentName: agentName })}</h3>
        <p role="status" className="text-sm text-muted-foreground">{labels[state]}{muted && !inactive ? t("microphone_muted_4ffc4f4") : ""}</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {inactive ? (
          <Button ref={startButton} size="sm" disabled={busy} onClick={onStart}><Phone aria-hidden="true" />{state === "failed" ? t("try_again_042c862") : t("start_voice_cc778bf")}</Button>
        ) : (
          <>
            <Button size="sm" variant="outline" aria-pressed={muted} disabled={busy || connecting || state === "ending" || state === "cleanup_failed"} onClick={onMute}>
              {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}{muted ? t("unmute_7044c31") : t("mute_0f09734")}
            </Button>
            <Button size="sm" variant="outline" disabled={state === "ending"} onClick={() => { restoreFocus.current = true; onEnd(); }}><PhoneOff aria-hidden="true" />{state === "cleanup_failed" ? t("retry_ending_call_3fb6f03") : t("end_call_c8de761")}</Button>
          </>
        )}
        {canRepeat && onRepeat && !inactive && <Button size="sm" variant="outline" disabled={busy || connecting || state === "ending" || state === "cleanup_failed"} onClick={onRepeat}><RotateCcw aria-hidden="true" />{t("repeat_answer_d673cde")}</Button>}
        {playbackBlocked && !inactive && <Button size="sm" variant="outline" onClick={onResumeAudio}><Volume2 aria-hidden="true" />{t("enable_audio_8e623ec")}</Button>}
      </div>
      {!inactive && <p className="text-xs text-muted-foreground">{t("ending_the_call_keeps_your_task_running_65ff528")}</p>}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    </section>
  );
}
