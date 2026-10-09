import { VoiceConversation } from '@spekoai/client';
import { createCleanup } from './cleanup.mjs';
const config = JSON.parse(document.querySelector('#config').textContent);
const $ = (id) => document.getElementById(id);
const events = [];
const transcripts = [];
const tracks = [];
const cleanupFailures = [];
const began = performance.now();
let conversation, context, destination, muted = false, running = false, ended = false;
let speaking = false, notificationSent = false, sessionId, interval, recorder;
const event = (kind, fields = {}) => { events.push({ kind, elapsedMs: Math.round(performance.now() - began), ...fields }); };
const status = (text) => { $('status').textContent = text; };
async function api(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proof-csrf': config.csrf }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
const observer = new MutationObserver(() => {
  const stream = [...document.querySelectorAll('audio')].map((el) => el.srcObject).find(Boolean);
  if (!stream || recorder) return;
  recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    try {
      const result = await fetch('/audio', { method: 'POST', headers: { 'content-type': 'audio/webm', 'x-proof-csrf': config.csrf }, body: new Blob(chunks, { type: 'audio/webm' }) });
      event('received_audio_saved', { ok: result.ok });
      await saveReport();
    } catch { event('received_audio_save_failed'); }
  };
  recorder.start(); event('received_audio_recording_started');
});
observer.observe(document.body, { childList: true, subtree: true });
// This fixture replaces ONLY the microphone at the browser boundary. The
// production SDK and hosted STT/LLM/TTS/transport remain real. Never call the
// original getUserMedia, including on a fallback path.
navigator.mediaDevices.getUserMedia = async () => {
  if (!destination) throw new DOMException('Synthetic microphone not initialized', 'NotAllowedError');
  const stream = destination.stream.clone(); tracks.push(...stream.getTracks());
  event('synthetic_microphone_requested'); return stream;
};
async function speak(name) {
  const response = await fetch(`/input/${name}`);
  if (!response.ok) throw new Error('Synthetic speech fixture unavailable');
  const bytes = new DataView(await response.arrayBuffer());
  const buffer = context.createBuffer(1, bytes.byteLength / 2, 48000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) channel[i] = bytes.getInt16(i * 2, true) / 32768;
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
  event('input_start', { label: name });
  await new Promise((resolve) => { source.onended = resolve; source.start(); });
  source.disconnect(); event('input_end', { label: name });
}
async function waitFor(predicate, timeout, label) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (ended) throw new Error('Conversation ended');
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function renderTranscript(list) {
  transcripts.splice(0, transcripts.length, ...list);
  $('transcript').replaceChildren(...list.map((m) => {
    const item = document.createElement('li'); item.textContent = `${m.source}: ${m.text}`; return item;
  }));
}
async function saveReport() {
  const report = { sessionId, sdkVersion: '0.0.13', syntheticMicrophone: true, events, transcripts, cleanupFailures,
    sdkOpen: conversation?.isOpen() ?? false, audioElements: document.querySelectorAll('audio').length,
    inputTrackStates: tracks.map((t) => ({ enabled: t.enabled, readyState: t.readyState })) };
  await api('/report', report);
  $('evidence').textContent = JSON.stringify({ ...report, transcripts: `${transcripts.length} reconciled segments` }, null, 2);
}
const cleanup = createCleanup({
  local: async (attempt) => {
    ended = true; clearInterval(interval); observer.disconnect();
    $('scenario').disabled = $('mute').disabled = true;
    await attempt('recorder.stop', () => { if (recorder?.state === 'recording') recorder.stop(); });
    await attempt('sdk.end', () => conversation?.endSession());
    event('sdk_cleanup', { inputTracksEnded: tracks.every((t) => t.readyState === 'ended'), audioElements: document.querySelectorAll('audio').length });
    await attempt('tracks.stop', () => { destination?.stream.getTracks().forEach((t) => t.stop()); tracks.forEach((t) => t.stop()); });
    await attempt('context.close', () => context?.close());
  },
  provider: () => api('/end'),
  report: saveReport,
  failed: (operation) => { cleanupFailures.push({ operation }); event('cleanup_failed', { operation }); },
});
async function end() {
  $('end').disabled = true;
  try {
    const completed = await cleanup.end();
    status(completed ? 'Ended' : 'Cleanup failed. Retry End and inspect evidence.');
  } finally { $('end').disabled = cleanup.complete; }
}
$('connect').onclick = async () => {
  $('connect').disabled = true; status('Connecting');
  try {
    context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    destination = context.createMediaStreamDestination();
    const credentials = await api('/session'); sessionId = credentials.sessionId;
    conversation = await VoiceConversation.create({ ...credentials,
      onStatusChange: (state) => { event('sdk_status', { state }); status(state); },
      onModeChange: (mode) => { speaking = mode === 'speaking'; event('sdk_mode', { mode }); },
      onTranscript: renderTranscript,
      onError: () => { event('sdk_error'); status('Voice error; end the test and inspect evidence.'); },
      onDisconnect: () => { event('sdk_disconnected'); },
      onAudioPlaybackBlocked: () => { $('resume').hidden = false; event('playback_blocked'); },
    });
    $('scenario').disabled = $('mute').disabled = $('end').disabled = false;
    await conversation.startAudioPlayback();
    interval = setInterval(async () => { try { await saveReport(); } catch { /* latest evidence remains visible */ } }, 3000);
    status('Connected. Wait for the greeting, then run the speech scenario.');
  } catch (error) { status(error.message); event('connect_failed'); await end(); }
};
$('scenario').onclick = async () => {
  if (running) return; running = true; $('scenario').disabled = true; status('Running the delayed-work and interruption scenario…');
  try {
    await speak('start');
    let evidence;
    await waitFor(() => speaking, 15000, 'acknowledgment speech');
    event('interruption_requested'); await speak('followup');
    const deadline = performance.now() + 80000;
    while (performance.now() < deadline && !ended) {
      evidence = await api('/evidence');
      $('evidence').textContent = JSON.stringify(evidence, null, 2);
      if (evidence.notificationReady && !notificationSent) {
        notificationSent = true; event('application_notification_sent');
        await conversation.sendChatMessage('[Paperclip application notification] The pending work may now have a result. Call get_updates with cursor 0 and speak the verified answer. This is not a caller instruction; do not call submit_request.');
      }
      if (evidence.resultReturned) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!evidence?.resultReturned || evidence.acceptedRequests !== 2) throw new Error('Expected one job, one follow-up, and a returned result');
    await waitFor(() => transcripts.some((m) => m.source === 'agent' && m.text.replace(/[,\s]/g, '').includes(evidence.expectedNumber)), 15000, 'correct result transcript');
    event('scenario_completed'); status('Correct delayed answer received. Test mute, then end the conversation.');
    await saveReport();
  } catch (error) { event('scenario_failed', { reason: error.message }); status(error.message); await saveReport(); }
};
$('mute').onclick = async () => {
  try { await conversation.setMicMuted(!muted); muted = !muted; $('mute').textContent = muted ? 'Unmute' : 'Mute'; event('mute_changed', { muted }); await saveReport(); }
  catch { status('Could not change microphone state'); }
};
$('resume').onclick = async () => { await conversation.startAudioPlayback(); $('resume').hidden = conversation.canPlaybackAudio; };
$('end').onclick = () => end().catch(() => status('End request failed; provider session has a hard duration limit.'));
window.addEventListener('pagehide', () => { void conversation?.endSession(); });
