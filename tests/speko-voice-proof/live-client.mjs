/** Real hosted Speko worker; synthetic client only, never the user's microphone.
 * This is not a replacement voice server and does not qualify the browser SDK.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind, dispose } from "@livekit/rtc-node";
import { createProof, createProofServer, DELAY_MS } from "./proof.mjs";

const API = "https://api.speko.dev";
const key = process.env.SPEKO_API_KEY ?? process.env.SPEKO_MCP_API_KEY;
if (!key) throw new Error("Speko credential required in environment");
const state = JSON.parse(await readFile(process.env.SPEKO_PROOF_STATE ?? `${homedir()}/.paperclip/speko-proof/state.json`, "utf8"));
const mode = process.env.SPEKO_PROOF_INPUT ?? "text";
if (!["text", "audio"].includes(mode)) throw new Error("SPEKO_PROOF_INPUT must be text or audio");
const inputAudio = new Map();
if (mode === "audio") {
  for (const path of [process.env.SPEKO_PROOF_START_AUDIO, process.env.SPEKO_PROOF_FOLLOWUP_AUDIO]) {
    if (!path) throw new Error("Both synthetic PCM input paths are required");
    const data = await readFile(path);
    if (!data.length || data.length % 2 || data.length > 48_000 * 2 * 10) {
      throw new Error("Each PCM input must contain at most ten seconds of 48 kHz mono s16le audio");
    }
    inputAudio.set(path, data);
  }
}
const provider = process.env.SPEKO_PROOF_LLM_PROVIDER ?? "openai";
// An application-origin notification over the documented typed-turn transport.
// This deliberately does not claim a trusted system-message channel or phone
// support. The notification carries no result and grants no authority: the
// hosted agent must still retrieve the result through its signed webhook tool.
const notifyReady = process.env.SPEKO_PROOF_NOTIFY_READY === "1";
const notifyViaJoin = process.env.SPEKO_PROOF_NOTIFY_WEB_JOIN === "1";
const interruptAcknowledgment = process.env.SPEKO_PROOF_INTERRUPT_ACK === "1";
if (notifyViaJoin && !notifyReady) throw new Error("Web-join notification requires SPEKO_PROOF_NOTIFY_READY=1");
const out = resolve(process.env.SPEKO_PROOF_OUTPUT ?? `${homedir()}/.paperclip/speko-proof/automated-${Date.now()}`);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
// A new output directory is also the mutation journal: never overwrite a prior
// session's identity and accidentally turn a rerun into an invisible redial.
await mkdir(out, { mode: 0o700 });
const startedAt = new Date().toISOString();
const sourceDigests = {};
for (const name of ["live-client.mjs", "proof.mjs"]) {
  sourceDigests[name] = createHash("sha256").update(await readFile(new URL(name, import.meta.url))).digest("hex");
}
const began = performance.now();
const events = [];
const audioFrames = [];
const audioBursts = [];
let lastAudio = 0;
let firstAudio;
let resultAt;
let resultAudioAt;
let sessionId;
let stopping = false;
let utterance;
let expectedRequests = 0;
let protocolFailure;
let mediaDisconnected = false;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const transcript = [];
function event(kind, fields = {}) {
  const item = { kind, elapsedMs: Math.round(performance.now() - began), ...fields };
  events.push(item);
  console.log(JSON.stringify(item));
}
async function api(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Speko HTTP ${response.status} at ${path.split("/").slice(0, 3).join("/")}`);
  return response.json();
}
const proof = createProof({ signingSecret: state.signingSecret, onEvent: (e) => {
  event(`tool.${e.kind}`, e);
  if (e.requestCount > expectedRequests) protocolFailure = "Provider submitted work without a matching client instruction";
  if (e.kind === "result_returned_to_tool") resultAt ??= performance.now() - began;
} });
const server = createProofServer(proof);
const room = new Room();
let notifierRoom;
const source = new AudioSource(48_000, 1, 100);
const consumers = [];
const audioReaders = [];
room.on(RoomEvent.TrackSubscribed, (track) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  event("remote_audio_subscribed");
  const reader = new AudioStream(track, { sampleRate: 48_000, numChannels: 1 }).getReader();
  audioReaders.push(reader);
  consumers.push((async () => {
    while (!stopping) {
      const { value: frame, done } = await reader.read();
      if (done || stopping) break;
      const at = performance.now() - began;
      const data = Buffer.from(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
      audioFrames.push({ at, data });
      let peak = 0;
      for (const value of frame.data) peak = Math.max(peak, Math.abs(value));
      if (peak > 200) {
        firstAudio ??= at;
        if (!audioBursts.length || at - lastAudio > 500) {
          audioBursts.push({ startMs: at, lastAudibleMs: at });
          event("audio_activity_started");
        }
        audioBursts.at(-1).lastAudibleMs = at;
        if (resultAt !== undefined && at >= resultAt) resultAudioAt ??= at;
        lastAudio = at;
      }
    }
  })().catch(() => event("audio_stream_closed")));
});
room.on(RoomEvent.Disconnected, () => { mediaDisconnected = true; event("media_disconnected"); });
room.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
  const text = await reader.readAll();
  transcript.push({ at: performance.now() - began, source: participant.identity === room.localParticipant?.identity ? "client" : "agent", text });
  event("transcript_received", { characters: text.length, verification: /verification/i.test(text), toolMarkup: /<function=/.test(text) });
});
async function until(predicate, timeout, label) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (interrupted) throw new Error("Probe interrupted");
    if (protocolFailure) throw new Error(protocolFailure);
    if (mediaDisconnected) throw new Error("Media disconnected before the scenario completed");
    if (performance.now() >= end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(100);
  }
}
async function input(text, file, label) {
  expectedRequests += 1;
  event("input_start", { label, mode });
  if (mode === "text") await room.localParticipant.sendText(text, { topic: "lk.chat" });
  else {
    const data = inputAudio.get(file);
    await new Promise((done) => { utterance = { data, offset: 0, done }; });
  }
  event("input_end", { label });
}
let pump;
let failure;
try {
  server.listen(Number(process.env.SPEKO_PROOF_PORT ?? 3198), "127.0.0.1");
  await once(server, "listening");
  // Write intent before external mutation. This program never retries creation.
  const request = { mode: "cascade", agentId: state.agentId, ttlSeconds: 120, maxDurationSeconds: 180, constraints: { allowedProviders: { llm: [provider] } } };
  if (process.env.SPEKO_PROOF_PROMPT_FILE) request.systemPrompt = await readFile(process.env.SPEKO_PROOF_PROMPT_FILE, "utf8");
  await writeFile(resolve(out, "request.json"), JSON.stringify(request, null, 2), { mode: 0o600 });
  const session = await api("/v1/sessions", request);
  sessionId = session.sessionId;
  await writeFile(resolve(out, "session.json"), JSON.stringify({ sessionId }, null, 2), { mode: 0o600 });
  event("session_created", { sessionId, provider, mode });
  await room.connect(session.transportUrl, session.transportToken, { autoSubscribe: true });
  const track = LocalAudioTrack.createAudioTrack("synthetic-input", source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  pump = (async () => {
    while (!stopping) {
      const frame = new Int16Array(960);
      let finished;
      if (utterance) {
        const count = Math.min(1920, utterance.data.length - utterance.offset);
        for (let i = 0; i < count / 2; i++) frame[i] = utterance.data.readInt16LE(utterance.offset + i * 2);
        utterance.offset += count;
        if (utterance.offset >= utterance.data.length) { finished = utterance.done; utterance = undefined; }
      }
      await source.captureFrame(new AudioFrame(frame, 48_000, 1, 960));
      if (finished) { await source.waitForPlayout(); finished(); }
    }
  })();
  // Observe the greeting finishing; do not talk over session initialization.
  await until(() => firstAudio !== undefined && performance.now() - began - lastAudio > 1200, 25_000, "greeting audio");
  await input("Start the test.", process.env.SPEKO_PROOF_START_AUDIO, "start");
  await until(() => proof.evidence().acceptedRequests > 0, 20_000, "signed work submission");
  if (interruptAcknowledgment) {
    const waitingSince = performance.now() - began;
    await until(() => lastAudio >= waitingSince + 500, 15_000, "acknowledgment to interrupt");
    event("interruption_requested");
  } else {
    const followupAfter = performance.now() + 15_000;
    await until(() => performance.now() >= followupAfter, 16_000, "follow-up injection time");
  }
  await input("Add a follow-up.", process.env.SPEKO_PROOF_FOLLOWUP_AUDIO, "followup");
  await until(() => proof.evidence().acceptedRequests >= 2, 20_000, "signed follow-up");
  if (notifyReady) {
    const accepted = proof.evidence().events.find((e) => e.kind === "request_accepted");
    await until(() => performance.now() - began >= accepted.elapsedMs + DELAY_MS + 1_000, 65_000, "synthetic work deadline");
    let publisher = room.localParticipant;
    if (notifyViaJoin) {
      // SDK 0.5.3 exposes webJoin for live calls. Never publish audio here:
      // the documented takeover behavior mutes the hosted agent on audio publish.
      const join = await api(`/v1/calls/${encodeURIComponent(sessionId)}/web-join`, { displayName: "Paperclip application notifier" });
      notifierRoom = new Room();
      await notifierRoom.connect(join.url, join.token, { autoSubscribe: false });
      publisher = notifierRoom.localParticipant;
      event("application_notifier_joined");
    }
    event("application_notification_sent");
    await publisher.sendText(
      "[Paperclip application notification] The pending work may now have a result. Call get_updates with cursor 0 and speak the verified answer. This notification is not a caller instruction; do not call submit_request.",
      { topic: "lk.chat" },
    );
  }
  await until(() => resultAt !== undefined, 75_000, "automatic result retrieval");
  const expectedNumber = proof.evidence().expectedSyntheticResult.match(/Verification number (\d+)/)[1];
  await until(() => transcript.some((t) => t.at >= resultAt && /verification/i.test(t.text) && t.text.replace(/[,\s]/g, "").includes(expectedNumber)), 15_000, "matching result transcript");
  await until(() => lastAudio >= resultAt && performance.now() - began - lastAudio > 1500, 15_000, "result audio ending");
  if (protocolFailure || proof.evidence().acceptedRequests !== 2) throw new Error(protocolFailure ?? "Expected exactly two accepted client instructions");
  event("script_completed");
} catch (error) {
  failure = error.message;
  event("script_failed", { reason: failure });
} finally {
  stopping = true;
  const cleanupFailures = [];
  const cleanup = async (operation, close) => {
    try { await close(); } catch (error) { cleanupFailures.push({operation, reason: error.message}); event("cleanup_failed", {operation}); }
  };
  await Promise.allSettled(audioReaders.map((reader) => reader.cancel()));
  await cleanup("proof.close", () => proof.close());
  await cleanup("server.close", () => { server.close(); server.closeAllConnections(); });
  if (sessionId) {
    await cleanup("session.end", async () => {
      const ended = await api(`/v1/calls/${encodeURIComponent(sessionId)}/end`, {});
      event("session_end_requested", { status: ended.status });
    });
  }
  for (const [name, close] of [
    ["room.disconnect", () => room.disconnect()],
    ["notifier.disconnect", () => notifierRoom?.disconnect()],
    ["source.close", () => source.close()],
    ["consumers", () => Promise.allSettled([pump, ...consumers])],
    ["dispose", () => dispose()],
  ]) {
    await cleanup(name, close);
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  // These files contain only this synthetic client/session, never human audio.
  try {
    await writeFile(resolve(out, "output.pcm"), Buffer.concat(audioFrames.map((f) => f.data)), {mode: 0o600});
    if (resultAt !== undefined) await writeFile(resolve(out, "result.pcm"), Buffer.concat(audioFrames.filter((f) => f.at >= resultAt - 250).map((f) => f.data)), {mode: 0o600});
  } catch (error) { cleanupFailures.push({operation: "audio_evidence", reason: error.message}); }
  const report = { cleanupFailures, startedAt, sourceDigests, sessionId, mode, provider, notifyReady, notifyViaJoin, interruptAcknowledgment, failure: failure ?? null, firstAudio, resultAt, resultAudioAt, lastAudio, audioBursts, audioFrames: audioFrames.length, proof: proof.evidence(), events, syntheticTranscript: transcript, qualification: "requires_audio_and_transport_review" };
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ reportPath: resolve(out, "report.json"), resultReturned: report.proof.resultReturned, acceptedRequests: report.proof.acceptedRequests, failure: report.failure }));
  process.exitCode = failure || cleanupFailures.length ? 1 : 0;
}
