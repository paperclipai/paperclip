/** Publish only an allowlisted, content-free view of a private synthetic run. */
import { readFile, writeFile } from "node:fs/promises";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node summarize-run.mjs private/report.json new-report.json");
const run = JSON.parse(await readFile(input, "utf8"));
const eventKinds = new Set([
  "session_created", "remote_audio_subscribed", "input_start", "input_end",
  "request_accepted", "followup_accepted", "poll_returned", "result_ready",
  "result_returned_to_tool", "tool_rejected", "transcript_received",
  "script_completed", "script_failed", "media_disconnected", "session_end_requested",
  "session_end_failed", "audio_stream_closed", "cleanup_failed",
  "application_notification_sent",
  "application_notifier_joined", "audio_activity_started",
  "interruption_requested",
]);
const events = run.events.filter((event) => eventKinds.has(event.kind)).map((event) => {
  const item = { kind: event.kind, elapsedMs: event.elapsedMs };
  for (const key of ["requestCount", "cursor", "jobElapsedMs", "characters", "verification", "toolMarkup"]) {
    if (["number", "boolean"].includes(typeof event[key])) item[key] = event[key];
  }
  if (["start", "followup"].includes(event.label)) item.label = event.label;
  return item;
});
const cleanupFailureCount = Math.max(run.cleanupFailures?.length ?? 0, run.events.filter(event => event.kind === "cleanup_failed").length);
const report = {
  date: run.startedAt ?? "2026-09-11 (exact start available from provider session)",
  sourceDigests: run.sourceDigests ? Object.fromEntries(
    ["live-client.mjs", "proof.mjs", "media-failure.mjs"]
      .filter((name) => /^[a-f0-9]{64}$/.test(run.sourceDigests[name] ?? ""))
      .map((name) => [name, run.sourceDigests[name]]),
  ) : null,
  sessionId: run.sessionId,
  input: run.mode,
  applicationNotification: run.notifyReady === true,
  applicationNotifierWebJoin: run.notifyViaJoin === true,
  interruptAcknowledgment: run.interruptAcknowledgment === true,
  llmConstraint: run.provider,
  status: run.failure || cleanupFailureCount ? "failed" : "requires_audio_review",
  cleanupFailureCount,
  failure: run.failure ? "Scenario did not complete; see qualification report for diagnosis" : cleanupFailureCount ? "Run cleanup did not complete; see private evidence for diagnosis" : null,
  acceptedRequests: run.proof.acceptedRequests,
  resultReturned: run.proof.resultReturned,
  synthesizedAudioReceived: run.audioFrames > 0,
  // A transcript event and RTP frames cannot establish that the answer was heard.
  confirmedResultPlayback: false,
  events,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
