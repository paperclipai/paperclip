/** Operator-only bounded personal Muse probe. Uses normal task APIs; never contacts Muse directly. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getStoredBoardCredential } from "../../cli/src/client/board-auth.js";
import type { MuseConnection, MuseQualificationEvidence } from "@paperclipai/shared";
import { qualificationReport, qualificationCadence } from "./muse-qualification-report.mjs";

const HOUR = 3_600_000;
interface Sample {
  slot: number; issueId?: string; queuedAt?: string; offeredAt?: string; claimedAt?: string;
  nativeAcceptedAt?: string; acceptedResultAt?: string; finalizedAt?: string;
  runId?: string; nativeSucceeded?: boolean; documentSha256?: string; unattended: true; attempts: number;
}
interface State {
  version: 2; apiBase: string; companyId: string; agentId: string; bindingId: string; generation: number;
  expectedRevision: number; qualificationId: string; evidenceMode: "live" | "synthetic"; startedAt?: string; expiresAt?: string;
  coreRevision: string; runnerRevision: string; environment: "local" | "cloud" | "self-hosted";
  samples: Sample[]; stopped: boolean; interventions: Array<{ kind: string; at: string }>;
}
if (process.argv.includes("--help")) {
  console.log("Muse qualification: start|check|stop|report --state <private-file>\nStart additionally requires --api-base <origin> --company-id <uuid> --agent-id <uuid> --core-revision <sha> --runner-revision <sha> --environment local|cloud|self-hosted --evidence-mode live|synthetic. Authenticate with paperclipai auth login first. The server enforces the 24-hour deadline; schedule check externally. No Muse cookie or API key is accepted.");
  process.exit(0);
}
const args = process.argv.slice(2);
const command = args.shift();
const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const required = (key: string) => { const result = value(key); if (!result || result.startsWith("--")) throw new Error(`${key} is required`); return result; };
const statePath = resolve(required("--state"));
const uuid = (input: string) => { if (!/^[a-f0-9-]{36}$/i.test(input)) throw new Error("Expected a UUID"); return input; };
const revision = (input: string) => { if (!/^[a-f0-9]{40}$/.test(input)) throw new Error("Supply the exact 40-character tested source revision"); return input; };
function origin(input: string) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("Use the public HTTPS origin, or an isolated loopback test instance");
  }
  return url.origin;
}
async function request<T>(state: Pick<State, "apiBase">, method: string, path: string, body?: unknown): Promise<T> {
  const credential = getStoredBoardCredential(state.apiBase);
  if (!credential) throw new Error("Run paperclipai auth login for the selected API origin first");
  const response = await fetch(state.apiBase + "/api" + path, { method,
    headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json", Accept: "application/json", Origin: state.apiBase },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Paperclip returned HTTP ${response.status}; the sample remains recorded`);
  if (response.status === 204) return undefined as T;
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Paperclip did not return protocol JSON");
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty Paperclip response");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    bytes += value.length; if (bytes > 4_000_000) { await reader.cancel(); throw new Error("Qualification evidence exceeds the bounded response limit"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
async function save(state: State) {
  const temporary = statePath + ".tmp";
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(state) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, statePath);
}
const base = (state: State) => `/companies/${state.companyId}/agents/${state.agentId}/muse-binding`;
const qualificationPath = (state: State) => base(state) + "/qualification";
async function status(state: State) { return request<MuseConnection>(state, "GET", base(state)); }
async function begin(state: State) {
  const result = await request<{ qualificationId: string; startedAt: string; expiresAt: string; revision: number }>(state, "POST", qualificationPath(state), {
    bindingId: state.bindingId, generation: state.generation, expectedRevision: state.expectedRevision, qualificationId: state.qualificationId,
  });
  if (result.qualificationId !== state.qualificationId || Date.parse(result.expiresAt) - Date.parse(result.startedAt) !== 24 * HOUR) {
    throw new Error("Server did not establish the exact bounded qualification");
  }
  state.startedAt = result.startedAt; state.expiresAt = result.expiresAt; state.expectedRevision = result.revision;
  await save(state);
}
async function readEvidence(state: State) {
  const query = new URLSearchParams({ bindingId: state.bindingId, qualificationId: state.qualificationId });
  return request<MuseQualificationEvidence>(state, "GET", qualificationPath(state) + "?" + query);
}
async function collect(state: State, evidence: MuseQualificationEvidence) {
  for (const sample of state.samples) {
    if (!sample.issueId) continue;
    const assignments = evidence.assignments.filter(assignment => assignment.issueId === sample.issueId);
    sample.attempts = assignments.length;
    if (assignments.length !== 1) continue;
    const assignment = assignments[0]!;
    sample.runId = assignment.runId;
    for (const key of ["offeredAt", "claimedAt", "nativeAcceptedAt", "acceptedResultAt", "finalizedAt"] as const) {
      if (assignment[key]) sample[key] = assignment[key]!;
    }
    if (!sample.finalizedAt || sample.documentSha256) continue;
    const issue = await request<{ status: string }>(state, "GET", `/issues/${sample.issueId}`);
    const run = await request<{ status: string; runtimeMode: string }>(state, "GET", `/heartbeat-runs/${sample.runId}`);
    if (issue.status !== "done" || run.status !== "succeeded" || run.runtimeMode !== "native") continue;
    const document = await request<{ body: string }>(state, "GET", `/issues/${sample.issueId}/documents/report`);
    if (!document.body?.trim()) continue;
    sample.nativeSucceeded = true;
    sample.documentSha256 = createHash("sha256").update(document.body).digest("hex");
  }
  await save(state);
}
async function tick(state: State, stop = false) {
  if (!state.startedAt) { if (stop) throw new Error("Qualification start is unresolved; inspect server evidence before cleanup"); await begin(state); }
  const expired = Date.now() >= Date.parse(state.expiresAt!);
  // Cleanup precedes task/document reads, so a broken sample cannot prolong the experiment.
  if ((stop || expired) && !state.stopped) {
    await request(state, "DELETE", qualificationPath(state), { bindingId: state.bindingId, qualificationId: state.qualificationId });
    state.stopped = true; await save(state);
  }
  const evidence = await readEvidence(state);
  await collect(state, evidence);
  const connection = await status(state);
  const binding = connection.binding;
  if (binding?.id !== state.bindingId || binding.generation !== state.generation) throw new Error("Connection changed; original qualification cannot be resumed");
  const hour = Math.floor((Date.now() - Date.parse(state.startedAt!)) / HOUR);
  const pending = state.samples.some(sample => !sample.nativeSucceeded);
  const healthy = binding.status === "ready" && binding.backgroundReplyVerified && binding.liveAssignments === 0
    && binding.uncertainOperations === 0 && binding.pendingInputs === 0 && binding.stop.status === "none"
    && binding.lastReceiverContactAt && Date.now() - Date.parse(binding.lastReceiverContactAt) < 90_000;
  if (!state.stopped && !expired && hour >= 0 && hour < 24 && !(hour >= 6 && hour < 9)
      && healthy && !pending && !state.samples.some(sample => sample.slot === hour)) {
    state.samples.push({ slot: hour, unattended: true, attempts: 0 }); await save(state);
  }
  // A lost create response retries the same public API idempotency key, never a new task.
  const creating = state.samples.find(sample => !sample.issueId);
  if (creating && !state.stopped && !expired && healthy) {
    const title = `Muse qualification sample ${creating.slot}`;
    const issue = await request<{ id: string; createdAt: string }>(state, "POST", `/companies/${state.companyId}/issues`, {
      title, description: `Unattended personal Muse receiver qualification, sample ${creating.slot}. Save a short Markdown task document with key report explaining which sample arrived and that it was received through the installed Paperclip receiver. Use only Paperclip task tools; no external service or unrelated changes. Complete this task through the native runner after saving the document.`,
      status: "todo", assigneeAgentId: state.agentId, idempotencyKey: `muse-qualification:${state.qualificationId}:${creating.slot}`,
    });
    creating.issueId = issue.id; creating.queuedAt = issue.createdAt; await save(state);
  }
  return { evidence, connection };
}
async function main() {
  if (command === "start") {
    try { await readFile(statePath); throw new Error("State exists; use check or a new state path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const environment = required("--environment");
    const evidenceMode = required("--evidence-mode");
    if (evidenceMode !== "live" && evidenceMode !== "synthetic") throw new Error("Declare live personal Muse or synthetic fixture evidence");
    if (!["local", "cloud", "self-hosted"].includes(environment)) throw new Error("Unknown environment");
    const state: State = { version: 2, apiBase: origin(required("--api-base")), companyId: uuid(required("--company-id")), agentId: uuid(required("--agent-id")),
      bindingId: "", generation: 0, expectedRevision: 0, qualificationId: randomUUID(), evidenceMode,
      coreRevision: revision(required("--core-revision")), runnerRevision: revision(required("--runner-revision")),
      environment: environment as State["environment"], samples: [], interventions: [], stopped: false };
    const connection = await status(state), binding = connection.binding;
    if (!binding || binding.status !== "ready" || !binding.backgroundReplyVerified || binding.liveAssignments || binding.uncertainOperations
        || binding.pendingInputs || binding.stop.status !== "none") throw new Error("Use an idle, verified personal Muse connection without uncertain work");
    state.bindingId = binding.id; state.generation = binding.generation; state.expectedRevision = binding.revision;
    await save(state); await begin(state);
    console.log(JSON.stringify({ started: true, expiresAt: state.expiresAt, plannedSamples: 21, idleWindowHours: [6, 9], requestedPollIntervalMs: 5000 }));
    return;
  }
  const state = JSON.parse(await readFile(statePath, "utf8")) as State;
  if (state.version !== 2 || origin(state.apiBase) !== state.apiBase) throw new Error("Unsupported qualification state");
  if (!["check", "stop", "report"].includes(command ?? "")) throw new Error("Use start, check, stop or report");
  const result = command === "report" ? { evidence: await readEvidence(state), connection: await status(state) } : await tick(state, command === "stop");
  // API evidence is retained privately. The dedicated projector prints only allowlisted facts.
  // Cadence remains unqualified until the server's complete bounded contact evidence is available.
  const report = qualificationReport({
    qualification: { startedAt: state.startedAt, expiresAt: state.expiresAt, requestedPollIntervalMs: 5000, deadlineEnforcedAt: result.evidence.deadlineEnforcedAt },
    provenance: { coreRevision: state.coreRevision, runnerRevision: state.runnerRevision, protocolVersion: 1, mode: state.evidenceMode, profile: "muse-personal", environment: state.environment },
    samples: state.samples, cadence: qualificationCadence(result.evidence), idleWindows: result.evidence.idleWindows.map(window => ({
      from: window.startedAt, to: window.endedAt, coverageComplete: result.evidence.cadenceEvidenceComplete,
      healthy: result.evidence.cadenceEvidenceComplete, activeAssignments: 0, unconsumedInputs: 0,
    })),
    cleanup: { authorityRevoked: result.evidence.authorityRevoked, workerStopUnconfirmed: result.connection.binding?.stop.status === "cannot_confirm" || result.connection.binding?.stop.status === "worker_reported",
      nativeEffectsUnknown: result.connection.binding?.stop.nativeEffectsUnknown ?? true },
    interventions: state.interventions,
  });
  console.log(JSON.stringify(report, null, 2));
}
await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
const lock = statePath + ".lock";
try {
  await mkdir(lock, { mode: 0o700 });
} catch { throw new Error("A qualification command owns this state lock; inspect an interrupted command before removing it"); }
try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : "Qualification failed; inspect retained state"); process.exitCode = 1; }
finally { await rm(lock, { recursive: true }); }
