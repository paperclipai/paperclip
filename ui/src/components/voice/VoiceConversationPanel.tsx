import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createVoiceSessionController, type VoiceSessionDependencies } from "@/lib/voice-session-controller";
import { VoiceControls } from "./VoiceControls";
import { VoiceTranscript } from "./VoiceTranscript";

export interface VoiceConversationPanelProps {
  agentName: string;
  autoStart?: boolean;
  accessRevoked?: boolean;
  onEndedChange?: (ended: boolean) => void;
  /** Keep this object stable for the lifetime of a task's voice panel. */
  dependencies: VoiceSessionDependencies;
  notification?: { sessionId: string; generation: number; publicationId: string; attempt?: number };
}

export function VoiceConversationPanel({ agentName, dependencies, notification, autoStart = false, onEndedChange, accessRevoked = false }: VoiceConversationPanelProps) {
  const controller = useMemo(() => createVoiceSessionController(dependencies), [dependencies]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const started = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // StrictMode's initial cleanup runs before this microtask. Never open media
    // for an already unmounted panel, or restart when call data changes.
    queueMicrotask(() => { if (!cancelled && autoStart && !started.current) { started.current = true; void controller.start(); } });
    return () => { cancelled = true; };
  }, [controller, autoStart]);
  useEffect(() => { onEndedChange?.(snapshot.state === "ended" || snapshot.state === "failed"); }, [snapshot.state, onEndedChange]);
  useEffect(() => () => { if (controller.getSnapshot().state !== "idle") void controller.stop(); }, [controller]);
  useEffect(() => { if (accessRevoked) void controller.stop(); }, [controller, accessRevoked]);
  useEffect(() => { if (notification) void controller.notify(notification); else controller.clearPendingNotifications(); }, [controller, notification?.sessionId, notification?.generation, notification?.publicationId, notification?.attempt]);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <VoiceControls {...snapshot} agentName={agentName} onStart={() => { void controller.start(); }} onMute={() => { void controller.mute(); }} onEnd={() => { void controller.stop(); }} onResumeAudio={() => { void controller.resumeAudio(); }} onRepeat={() => { void controller.repeat(); }} />
      <div className="max-h-64 overflow-y-auto" role="region" aria-label="Voice transcript history" tabIndex={snapshot.transcript.length ? 0 : undefined}><VoiceTranscript entries={snapshot.transcript} agentName={agentName} /></div>
    </div>
  );
}
