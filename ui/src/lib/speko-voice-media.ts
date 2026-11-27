import type { VoiceMediaCallbacks, VoiceMediaCredentials } from "./voice-session-controller";

/** Load media after the server authorizes a user-initiated session. */
export async function connectSpekoVoiceMedia(credentials: VoiceMediaCredentials, callbacks: VoiceMediaCallbacks) {
  const { VoiceConversation } = await import("@spekoai/client");
  const conversation = await VoiceConversation.create({
    transportToken: credentials.transportToken,
    transportUrl: credentials.transportUrl,
    onModeChange: callbacks.onModeChange,
    onDisconnect: callbacks.onDisconnect,
    onAudioPlaybackBlocked: callbacks.onAudioPlaybackBlocked,
    onMessage: (message) => callbacks.onMessage({ source: message.source, text: message.text, isFinal: message.isFinal, segmentId: message.segmentId }),
  });
  return {
    endSession: () => conversation.endSession(),
    setMicMuted: (muted: boolean) => conversation.setMicMuted(muted),
    sendChatMessage: (text: string) => conversation.sendChatMessage(text),
    async startAudioPlayback() {
      await conversation.startAudioPlayback();
      if (!conversation.canPlaybackAudio) throw new Error("Audio playback remains blocked");
    },
  };
}
