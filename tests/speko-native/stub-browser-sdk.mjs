/** Replaces only @spekoai/client's external media boundary in browser tests. */
export class VoiceConversation {
  static async create(options) {
    const state = window.__spekoTransport = { open: true, muted: false, creates: (window.__spekoTransport?.creates ?? 0) + 1, closes: window.__spekoTransport?.closes ?? 0, cursor: 0 };
    const sessionId = options.transportToken.replace('fixture:', '');
    const command = async (tool, args, toolCallId) => {
      const response = await fetch('http://127.0.0.1:__STUB_PORT__/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, tool, args, toolCallId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(`Signed callback rejected: ${response.status}`);
      return result;
    };
    state.speak = async (text, toolCallId) => {
      options.onMessage({ source: 'user', text, segmentId: crypto.randomUUID(), isFinal: true });
      const result = await command('submit_request', { text }, toolCallId);
      options.onModeChange('speaking');
      options.onMessage({ source: 'agent', text: result.message, segmentId: crypto.randomUUID(), isFinal: true });
      options.onModeChange('listening');
      return result;
    };
    state.answer = (interactionId, answers, toolCallId) => command('answer_question', { interactionId, answers }, toolCallId);
    options.onModeChange('listening');
    return {
      canPlaybackAudio: true,
      async endSession() { if (state.open) { state.open = false; state.closes++; } },
      async setMicMuted(value) { state.muted = value; },
      async startAudioPlayback() {},
      async sendChatMessage(message) {
        if (!state.open) throw new Error('Fixture media already closed');
        const result = await command('get_updates', { cursor: state.cursor, ...(message.includes('repeat=true') ? { repeat: true } : {}) });
        state.cursor = result.cursor;
        for (const update of result.updates) {
          if (update.question) state.question = update.question;
          options.onModeChange('speaking');
          options.onMessage({ source: 'agent', text: update.text, segmentId: crypto.randomUUID(), isFinal: true });
          options.onModeChange('listening');
        }
      },
    };
  }
}
