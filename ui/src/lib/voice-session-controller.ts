import { VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION } from "@paperclipai/shared";
export { VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION } from "@paperclipai/shared";
import type { VoiceControlState } from "../components/voice/VoiceControls";
import { updateVoiceTranscript, type VoiceTranscriptEntry, type VoiceTranscriptUpdate } from "./voice-transcript";

export class VoiceSessionStartError extends Error {
  constructor(readonly sessionId: string, readonly reason?: "credits_required") { super("The call needs cleanup before reconnecting"); }
}

export interface VoiceMediaCredentials {
  sessionId: string;
  generation: number;
  transportToken: string;
  transportUrl: string;
}
export interface VoiceMedia {
  endSession(): Promise<void>;
  setMicMuted(muted: boolean): Promise<void>;
  sendChatMessage(text: string): Promise<void>;
  startAudioPlayback(): Promise<void>;
}
export interface VoiceMediaCallbacks {
  onMessage(update: VoiceTranscriptUpdate): void;
  onModeChange(mode: "listening" | "speaking"): void;
  onDisconnect(): void;
  onAudioPlaybackBlocked(): void;
}
export interface VoiceSessionSnapshot {
  state: VoiceControlState;
  muted: boolean;
  busy: boolean;
  playbackBlocked: boolean;
  canRepeat?: boolean;
  transcript: readonly VoiceTranscriptEntry[];
  announcement: string;
  error?: string;
}
export interface VoiceSessionDependencies {
  /** Server authorizes endpoint, company, task and actor before minting. */
  mint(): Promise<VoiceMediaCredentials>;
  end(sessionId: string): Promise<void>;
  connect(credentials: VoiceMediaCredentials, callbacks: VoiceMediaCallbacks): Promise<VoiceMedia>;
}




/** Media lifecycle only. Ending a call never invokes task cancellation. */
export function createVoiceSessionController(dependencies: VoiceSessionDependencies) {
  let snapshot: VoiceSessionSnapshot = { state: "idle", muted: false, busy: false, playbackBlocked: false, transcript: [], announcement: "" };
  const listeners = new Set<() => void>();
  let epoch = 0, media: VoiceMedia | undefined, credentials: VoiceMediaCredentials | undefined;
  let cleanupSessionId: string | undefined;
  let startup: Promise<void> | undefined, stopping: Promise<void> | undefined;
  const notifications = new Set<string>();
  const queuedNotifications = new Map<string, { sessionId: string; generation: number; publicationId: string; attempt?: number }>();
  const unfinishedAgentSegments = new Set<string>();
  const interruptedAgentSegments = new Set<string>();
  const fallbackSegments = new Map<string, { id: string; final: boolean; text: string }>();
  let sequence = 0, hintSending = false, hintSentAt = Number.NEGATIVE_INFINITY;
  let quietAfter = 0;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  function clearNotificationTimer() { clearTimeout(notificationTimer); notificationTimer = undefined; }
  function noteActivity() {
    // SDK mode is LiveKit's active-speaker amplitude, not a completed turn.
    // Word pauses must not authorize a new typed turn that interrupts playback.
    quietAfter = Date.now() + 1_500;
    scheduleNotifications();
  }
  function scheduleNotifications() {
    clearNotificationTimer();
    if (!queuedNotifications.size || !media || stopping || hintSending || snapshot.state === "speaking" || unfinishedAgentSegments.size || snapshot.playbackBlocked) return;
    const delay = Math.max(0, quietAfter - Date.now(), hintSentAt + 10_000 - Date.now());
    notificationTimer = setTimeout(() => { notificationTimer = undefined; flushNotifications(); }, delay);
  }
  const change = (patch: Partial<VoiceSessionSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach((listener) => listener()); };
  async function cleanup() {
    const ownedMedia = media, ownedCredentials = credentials, ownedSessionId = credentials?.sessionId ?? cleanupSessionId;
    const results = await Promise.allSettled([
      Promise.resolve().then(async () => { if (ownedMedia) { await ownedMedia.endSession(); if (media === ownedMedia) media = undefined; } }),
      Promise.resolve().then(async () => { if (ownedSessionId) { await dependencies.end(ownedSessionId); if (credentials === ownedCredentials) credentials = undefined; if (cleanupSessionId === ownedSessionId) cleanupSessionId = undefined; } }),
    ]);
    return results.every((result) => result.status === "fulfilled");
  }
  function stop() {
    if (stopping) return stopping;
    if (snapshot.state === "ended" && !startup && !media && !credentials && !cleanupSessionId) return Promise.resolve();
    epoch++;
    clearNotificationTimer(); queuedNotifications.clear();
    change({ state: "ending", busy: true, error: undefined });
    // Join creation before declaring the call ended: a late token or media
    // connection still belongs to this call and must be closed too.
    const operation = (async () => {
      await startup;
      const closed = await cleanup();
      change({ state: closed ? "ended" : "cleanup_failed", busy: false, playbackBlocked: false, muted: false,
        error: closed ? undefined : "The call could not be fully closed. Retry ending it before starting another call." });
    })();
    stopping = operation.finally(() => { stopping = undefined; });
    return stopping;
  }
  async function start() {
    if (!["idle", "ended", "failed"].includes(snapshot.state) || startup || stopping || media || credentials || cleanupSessionId) return;
    const ownedEpoch = ++epoch;
    notifications.clear(); queuedNotifications.clear(); unfinishedAgentSegments.clear(); interruptedAgentSegments.clear(); fallbackSegments.clear(); sequence = 0; hintSentAt = Number.NEGATIVE_INFINITY; hintSending = false; quietAfter = 0; clearNotificationTimer();
    change({ state: "connecting", busy: true, muted: false, canRepeat: false, error: undefined, playbackBlocked: false, transcript: [], announcement: "" });
    let failed = false, recovering = false, creditsRequired = false;
    const operation = (async () => {
      try {
        credentials = await dependencies.mint();
        if (epoch !== ownedEpoch) return;
        media = await dependencies.connect(credentials, {
          onModeChange(mode) { if (epoch === ownedEpoch) { change({ state: mode }); noteActivity(); } },
          onDisconnect() { if (epoch === ownedEpoch) void stop(); },
          onAudioPlaybackBlocked() { if (epoch === ownedEpoch) change({ playbackBlocked: true }); },
          onMessage(update) {
            if (epoch !== ownedEpoch || update.source === "user" && [VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION].includes(update.text) || !update.text.trim()) return;
            let segmentId = update.segmentId;
            if (!segmentId) {
              let fallback = fallbackSegments.get(update.source);
              if (!fallback || fallback.final && fallback.text !== update.text) fallback = { id: `unsegmented-${++sequence}`, final: false, text: "" };
              segmentId = fallback.id;
              fallbackSegments.set(update.source, { id: segmentId, final: fallback.final || update.isFinal, text: update.text });
            }
            const transcript = updateVoiceTranscript(snapshot.transcript, { ...update, segmentId }, segmentId);
            const entry = transcript.find((item) => item.id === `${update.source}:${segmentId}`);
            const previous = snapshot.transcript.find((item) => item.id === entry?.id);
            // Active-speaker silence can occur in the middle of a streamed
            // sentence. Wait for its final transcript before admitting another
            // background typed turn. A real caller interruption retires the old
            // pending speech; it does not mean that speech was fully heard.
            if (update.source === "user") {
              for (const id of unfinishedAgentSegments) interruptedAgentSegments.add(id);
              unfinishedAgentSegments.clear();
            } else if (entry?.final || interruptedAgentSegments.has(segmentId)) unfinishedAgentSegments.delete(segmentId);
            else unfinishedAgentSegments.add(segmentId);
            noteActivity();
            change({ transcript, ...(update.isFinal && entry && (!previous?.final || previous.text !== entry.text) ? { announcement: `${update.source === "user" ? "You" : "Agent"}: ${update.text}` } : {}) });
          },
        });
        if (epoch === ownedEpoch) {
          change({ state: snapshot.state === "connecting" ? "listening" : snapshot.state, busy: false, canRepeat: true });
          flushNotifications();
        }
      } catch (error) { if (error instanceof VoiceSessionStartError) { cleanupSessionId = error.sessionId; recovering = true; creditsRequired = error.reason === "credits_required"; } failed = true; }
    })();
    startup = operation;
    await operation;
    if (startup === operation) startup = undefined;
    if (failed && epoch === ownedEpoch) {
      // Stop also retires callbacks from media that failed during creation.
      await stop();
      if (snapshot.state === "ended") change({ state: "failed", error: creditsRequired ? "Speko needs credits before starting a call. Add credits in Speko, then try again." : recovering ? "The previous call was closed. Start voice again to reconnect; your task is preserved." : "Voice could not connect. Check microphone permissions and your connection, then try again." });
    }
  }
  async function mute() {
    if (!media || snapshot.busy || stopping) return;
    const owned = media, ownedEpoch = epoch, target = !snapshot.muted;
    change({ busy: true });
    try { await owned.setMicMuted(target); if (epoch === ownedEpoch) change({ muted: target, error: undefined }); }
    catch { if (epoch === ownedEpoch) change({ error: "Microphone state could not be changed. Try again or end the call." }); }
    finally { if (epoch === ownedEpoch) change({ busy: false }); }
  }
  function flushNotifications() {
    if (!media || stopping) return;
    // Hints carry no result text. One hint is enough to request the next
    // durable answer; a burst of hints would interrupt the voice persona.
    const pending = [...queuedNotifications.values()].at(-1); queuedNotifications.clear();
    if (pending) void notify(pending);
  }
  async function notify(input: { sessionId: string; generation: number; publicationId: string; attempt?: number }) {
    const notificationKey = `${input.publicationId}:${input.attempt ?? 0}`;
    if (!credentials || stopping || input.sessionId !== credentials.sessionId || input.generation !== credentials.generation || notifications.has(notificationKey)) return false;
    if (!media || snapshot.state === "speaking" || unfinishedAgentSegments.size || snapshot.playbackBlocked || hintSending || Date.now() < quietAfter || Date.now() - hintSentAt < 10_000) { queuedNotifications.clear(); queuedNotifications.set(input.publicationId, input); scheduleNotifications(); return false; }
    const ownedEpoch = epoch;
    // Reserve before awaiting delivery. An ambiguous transport failure is not
    // permission to replay the same attempt. Only a fresh server check that
    // the publication remains unclaimed can authorize a later hint.
    notifications.add(notificationKey);
    hintSending = true; hintSentAt = Date.now();
    try {
      await media.sendChatMessage(VOICE_RESULT_NOTIFICATION);
      if (epoch !== ownedEpoch) return false;
      change({ canRepeat: true });
      if (!snapshot.transcript.some((entry) => entry.id === `publication:${input.publicationId}`)) change({ transcript: [...snapshot.transcript, { id: `publication:${input.publicationId}`, source: "application", text: "A task update is available.", final: true }] });
      return true;
    } catch { if (epoch === ownedEpoch) change({ error: "A task update could not be delivered to voice. Open the task to read it." }); return false; }
    finally { if (epoch === ownedEpoch) { hintSending = false; scheduleNotifications(); } }
  }
  function clearPendingNotifications() { queuedNotifications.clear(); clearNotificationTimer(); }
  async function repeat() {
    if (!media || stopping || snapshot.busy || hintSending || !snapshot.canRepeat) return;
    const ownedEpoch = epoch;
    // A caller-initiated repeat may interrupt speech; background results may not.
    change({ busy: true });
    hintSentAt = Date.now(); hintSending = true;
    try { await media.sendChatMessage(VOICE_REPEAT_NOTIFICATION); }
    catch { if (epoch === ownedEpoch) change({ error: "The answer could not be repeated. Open the task to read it." }); }
    finally { if (epoch === ownedEpoch) { hintSending = false; change({ busy: false }); scheduleNotifications(); } }
  }
  async function resumeAudio() {
    if (!media || stopping) return;
    const ownedEpoch = epoch;
    try { await media.startAudioPlayback(); if (epoch === ownedEpoch) { change({ playbackBlocked: false }); scheduleNotifications(); } }
    catch { if (epoch === ownedEpoch) change({ error: "Audio playback is blocked. Check this browser’s sound settings." }); }
  }
  return { start, stop, mute, notify, repeat, clearPendingNotifications, resumeAudio, getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
