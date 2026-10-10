/** Opt-in deterministic operator smoke against an isolated loopback server.
 * This scripts a synthetic external worker through production HTTP/native Runner
 * surfaces. It is not a registered Product E2E campaign or live Muse qualification.
 * pnpm --filter @paperclipai/server exec tsx scripts/muse-runner-smoke.ts --run --base http://127.0.0.1:3311 \
 *   --auth-file /private/path/operator.json --company <uuid> --agent <uuid> \
 *   --instance <instance-id> --server-source-sha <40-char-sha> --evidence-dir /private/path/evidence
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { digestPaperclipSemanticContent } from "../src/vendor/paperclip-runner/index.js";

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected an object");
  return value as Json;
}
function string(value: unknown): string { assert.equal(typeof value, "string"); return value as string; }
function rows(value: unknown): Json[] { assert.ok(Array.isArray(value)); return value.map(object); }
function option(name: string): string {
  const index = process.argv.indexOf(name);
  assert.ok(index >= 0 && process.argv[index + 1], `Missing ${name}`);
  return process.argv[index + 1];
}
if (process.argv.includes("--help")) {
  console.log("Synthetic Muse smoke: --run --base <loopback-url> --auth-file <private-json> --company <uuid> --agent <uuid> --instance <instance-id> --server-source-sha <sha> --evidence-dir <private-dir>");
  process.exit(0);
}
assert.ok(process.argv.includes("--run"), "Pass --run for this bounded synthetic smoke");
const base = new URL(option("--base"));
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Use an isolated loopback server");
assert.ok(["http:", "https:"].includes(base.protocol) && !base.username && !base.password && base.pathname === "/");
const authFile = option("--auth-file"), companyId = option("--company"), agentId = option("--agent");
const serverSourceSha = option("--server-source-sha"), instanceId = option("--instance");
assert.match(serverSourceSha, /^[a-f0-9]{40}$/);
assert.match(companyId, /^[a-f0-9-]{36}$/); assert.match(agentId, /^[a-f0-9-]{36}$/);
const evidenceDirectory = resolve(option("--evidence-dir"));
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const operator = object(JSON.parse(await readFile(authFile, "utf8")));
const cookie = string(operator.cookie);
assert.equal(operator.base, base.origin, "The private operator session must belong to this target");
assert.equal(operator.companyId, companyId, "Use the authorized isolated company");
const startedAt = new Date().toISOString(), deadline = Date.now() + 5 * 60_000;
const marker = `synthetic-muse-${randomUUID()}`;
const bindingPath = `/api/companies/${companyId}/agents/${agentId}/muse-binding`;
const evidence: Json = {
  schema: "paperclip.synthetic-muse-smoke.v1", synthetic: true,
  registeredCampaign: false, liveMuseQualification: false, browserVerified: false,
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), serverSourceSha,
  scriptSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
  target: base.origin, companyId, agentId, marker, startedAt,
  worker: "scripted HTTP peer; no real Muse, model, or hooks installation",
  profile: { provider: "muse", driver: "muse_external", bridgeRevision: "muse-v1", expectedTurns: 2 },
  accounting: { providerCalls: 0, usage: null, cost: null, coverage: "unavailable" },
  assertions: [], steps: [], operations: [], cleanup: {},
};
let stage = "preflight", credentials: Json | undefined, detectorTimer: NodeJS.Timeout | undefined;
let detectorRequests = 0, detectorError = false, issueId: string | undefined, createdBindingId: string | undefined;
let detectorFlight: Promise<void> | undefined, cleanupDeadline: number | undefined;
const runIds: string[] = [], operationEvidence: Json[] = [];
function step(name: string, details: Json = {}) {
  stage = name; (evidence.steps as Json[]).push({ stage: name, at: new Date().toISOString(), ...details });
  console.log(JSON.stringify({ synthetic: true, stage: name, ...details }));
}
async function http(path: string, method = "GET", body?: Json, token?: string, board = false, headers: Record<string, string> = {}): Promise<unknown> {
  const requestDeadline = cleanupDeadline ?? deadline;
  assert.ok(Date.now() < requestDeadline, "Smoke deadline exceeded");
  const response = await fetch(new URL(path, base), {
    method, headers: { ...(board ? { Cookie: cookie, Origin: base.origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.max(1, Math.min(15000, requestDeadline - Date.now()))), redirect: "error",
  });
  // Never print transport bodies: pairing responses contain private credentials.
  assert.ok(response.ok, `HTTP ${response.status} at ${method} ${path}`);
  return response.status === 204 ? null : response.json();
}
const board = (path: string, method = "GET", body?: Json) => http(path, method, body, undefined, true);
const query = async (body: Json) => object(await http("/api/muse/v1/queries", "POST", { version: 1, ...body }, string(credentials?.accessToken)));
async function command(body: Json): Promise<Json> {
  const requestId = typeof body.requestId === "string" ? body.requestId : randomUUID();
  let outcome = object(await http("/api/muse/v1/commands", "POST", { version: 1, ...body, requestId }, string(credentials?.accessToken)));
  while (["pending", "reserved", "dispatched"].includes(String(outcome.status))
    && !(body.command === "request_user_input" && outcome.requestId === body.nativeRequestId)) {
    assert.equal(typeof body.assignmentId, "string", "Only assigned operations may return pending");
    await delay(150);
    outcome = await query({ query: "operation.receipt", assignmentId: body.assignmentId, requestId });
  }
  assert.ok(!["unknown", "rejected"].includes(String(outcome.status)), "An uncertain/rejected operation cannot be retried with a new ID");
  assert.notEqual(outcome.isError, true, `Native ${String(body.name ?? body.command)} failed`);
  operationEvidence.push({ requestId, command: body.command, ...(body.name ? { tool: body.name } : {}), status: outcome.status });
  evidence.operations = operationEvidence;
  return outcome;
}
async function until<T>(name: string, read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  while (Date.now() < deadline) {
    const value = await read(); if (predicate(value)) return value;
    await delay(250);
  }
  throw new Error(`Deadline while waiting for ${name}`);
}
async function signal() {
  // This fallback belongs only to this synthetic operator peer. Real Muse
  // detectors cannot use credentials; their contract is the public binding header.
  const legacySyntheticToken = typeof credentials?.signalToken === "string" ? credentials.signalToken : undefined;
  await http("/api/muse/v1/signal", "GET", undefined, legacySyntheticToken, false,
    legacySyntheticToken ? {} : { "X-Paperclip-Muse-Binding": string(credentials?.bindingId) });
  detectorRequests++;
}
async function assignment(): Promise<Json> {
  return until<Json>("an offered assignment", async () => {
    const runs = rows(await board(`/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=100`));
    const terminal = runs.find(run => !runIds.includes(string(run.id))
      && (run.issueId === issueId || run.nativeIssueId === issueId || object(run.contextSnapshot ?? {}).issueId === issueId)
      && ["failed", "cancelled", "timed_out"].includes(String(run.status)));
    if (terminal) {
      const run = object(await board(`/api/heartbeat-runs/${string(terminal.id)}`));
      evidence.nativeStartupFailure = { runId: run.id, status: run.status, runtimeMode: run.runtimeMode,
        driverKind: run.driverKind, nativePhase: run.nativePhase, errorCode: run.errorCode, error: run.error,
        createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt };
      step("native-startup-failed", { runId: run.id, status: run.status });
      throw new Error(`Native run ${string(run.id)} ended before an offered assignment; inspect nativeStartupFailure`);
    }
    const mailbox = await query({ query: "mailbox", after: 0 });
    const item = rows(mailbox.items).find(row => row.kind === "assignment" && !runIds.includes(string(object(row.references).runId)));
    return item ? query({ query: "assignment.read", assignmentId: object(item.references).assignmentId }) : {};
  }, value => typeof value.assignmentId === "string" && value.status === "offered");
}
async function accept(work: Json): Promise<void> {
  const ref = object(work.binding), runId = string(ref.runId);
  runIds.push(runId); assert.ok(runIds.length <= 2, "Only two native turns are authorized");
  await command({ command: "accept", assignmentId: work.assignmentId });
  const run = object(await board(`/api/heartbeat-runs/${runId}`));
  assert.equal(run.runtimeMode, "native"); assert.equal(run.driverKind, "muse_external");
  assert.equal(run.status, "running");
  const profile = object(object(run.runnerProfileJson).nativeExecutionInput);
  assert.equal(profile.schema, "paperclip.native-execution-input.v7");
  assert.equal(object(profile.workspace).access, "none");
  step("native-accepted", { turn: runIds.length, runId });
}
async function finish(work: Json, summary: string): Promise<void> {
  const contract = object(work.completionContract);
  const result = { reportedWorkDisposition: "completed", summary,
    completionClaim: { contractRevision: string(contract.revision), objectiveSatisfied: true,
      criteria: (contract.criterionIds as unknown[]).map(id => ({ criterionId: string(id), status: "passed", evidenceRefs: [] })), remainingWork: [] },
    evidence: [], verification: [{ commandOrCheck: "Independent board document readback", status: "pass" }] };
  const receipt = await command({ command: "tool", assignmentId: work.assignmentId, name: "paperclip_finish", arguments: result });
  const canonical = object(object(receipt.result).completionReport);
  assert.equal(canonical.schema, "paperclip.run_result.v1"); assert.equal(canonical.reportedWorkDisposition, "done");
  await command({ command: "finish", assignmentId: work.assignmentId, result: canonical });
  const runId = string(object(work.binding).runId);
  const run = await until("server native finalization", async () => object(await board(`/api/heartbeat-runs/${runId}`)), value =>
    value.status === "succeeded" && object(value.resultJson).finalizationPhase === "committed");
  const issue = object(await board(`/api/issues/${issueId}`)); assert.equal(issue.status, "done"); assert.equal(issue.executionRunId, null);
  await until("released Muse assignment", async () => object(object(await board(bindingPath)).binding), value =>
    value.liveAssignments === 0 && value.uncertainOperations === 0 && object(value.stop).status === "none");
  (evidence.assertions as Json[]).push({ assertion: "native-server-finalization", runId, status: run.status,
    finishedAt: run.finishedAt, nativePhase: run.nativePhase, finalizationPhase: object(run.resultJson).finalizationPhase,
    issueStatus: issue.status, canonicalReportSchema: canonical.schema });
  step("server-finalized", { turn: runIds.length, runId });
}
try {
  const health = object(await board("/api/health")); assert.equal(health.status, "ok"); assert.equal(health.authReady, true);
  assert.equal(health.commit, serverSourceSha, "Use the stable isolated checkout SHA for this smoke");
  if (health.devServer && typeof object(health.devServer).restartRequired === "boolean") assert.equal(object(health.devServer).restartRequired, false, "Restart the isolated dev server before this smoke");
  const settings = object(await board("/api/instance/settings/experimental"));
  assert.equal(settings.enableMuse, true); assert.equal(settings.enableNativeRunner, true);
  assert.equal(settings.enableWorktreeRunExecution, true, "Activate isolated worktree execution before creating this issue");
  assert.equal(settings.worktreeRunExecutionActivationInstanceId, instanceId, "Activation must match the isolated instance");
  const cutoff = string(settings.worktreeRunExecutionActivatedAt);
  assert.ok(Number.isFinite(Date.parse(cutoff)) && Date.parse(cutoff) <= Date.now(), "Execution cutoff must be armed");
  const initial = object(await board(bindingPath)); assert.equal(initial.enabled, true);
  const publicOrigin = new URL(string(initial.publicOrigin));
  assert.equal(publicOrigin.protocol, "https:", "Configure the synthetic public setup origin before pairing");
  assert.ok(!publicOrigin.username && !publicOrigin.password && publicOrigin.pathname === "/" && !publicOrigin.search && !publicOrigin.hash);
  evidence.preflight = { instanceId, armedWorktreeExecution: true, executionCutoff: cutoff, publicOrigin: publicOrigin.origin,
    observedCurrentCheckoutSha: health.commit, processStartedAt: object(health.serverInfo).processStartedAt, normalBoardOrigin: base.origin };
  if (initial.binding) {
    const existing = object(initial.binding);
    assert.equal(existing.liveAssignments, 0, "Do not replace active work");
    assert.equal(existing.uncertainOperations, 0, "Resolve previous native effects before this smoke");
    assert.equal(object(existing.stop).status, "none", "Resolve previous worker uncertainty before this smoke");
  }
  step("pairing");
  const previous = initial.binding ? object(initial.binding) : undefined;
  const pairing = object(await board(bindingPath, "POST", previous && previous.status !== "revoked"
    ? { replaceBindingId: previous.id, expectedRevision: previous.revision } : {}));
  createdBindingId = string(pairing.bindingId);
  credentials = object(await http("/api/muse/v1/pair", "POST", { version: 1, ticket: pairing.ticket, clientVersion: "1" }));
  assert.equal(credentials.companyId, companyId); assert.equal(credentials.agentId, agentId);
  evidence.signalMode = typeof credentials.signalToken === "string" ? "authenticated_synthetic" : "public_binding_header";
  evidence.liveMuseDetectorCompatible = evidence.signalMode === "public_binding_header";
  await signal(); detectorTimer = setInterval(() => {
    if (detectorFlight) return;
    detectorFlight = signal().catch(() => { detectorError = true; }).finally(() => { detectorFlight = undefined; });
  }, 5000);
  const challenge = await until("persisted detector contact and challenge", async () => {
    const mailbox = await query({ query: "mailbox", after: 0 });
    return rows(mailbox.items).find(row => row.kind === "readiness_challenge") ?? {};
  }, value => typeof object(value.references ?? {}).nonce === "string");
  await command({ command: "challenge.confirm", nonce: object(challenge.references).nonce });
  const ready = object(object(await board(bindingPath)).binding);
  assert.equal(ready.status, "ready"); assert.equal(ready.receiverDetected, true); assert.equal(ready.backgroundReplyVerified, true);
  step("synthetic-readiness-verified");
  const created = object(await board(`/api/companies/${companyId}/issues`, "POST", {
    title: `Synthetic Muse native smoke ${marker}`, description: "A deterministic two-turn operator smoke. Write the synthetic report, ask its native question, finish, then apply the synthetic follow-up.",
    status: "todo", assigneeAgentId: agentId, responsibleUserId: operator.userId, reviewPolicy: null, priority: "low",
  }));
  issueId = string(created.id); evidence.issueId = issueId;
  const first = await assignment(); await accept(first);
  const documentBody = `# Synthetic Muse report\n\nMarker: ${marker}\n\n17 + 25 = 42.\n`;
  await command({ command: "tool", assignmentId: first.assignmentId, name: "write_document", arguments: {
    key: "report", title: "Synthetic Muse report", body: documentBody, baseRevisionId: null, idempotencyKey: randomUUID() } });
  const document = object(await board(`/api/issues/${issueId}/documents/report`)); assert.equal(document.body, documentBody.trim());
  step("native-document-written", { runId: runIds[0], canonicalBody: true });
  const nativeRequestId = `smoke-question-${randomUUID()}`;
  await command({ command: "request_user_input", assignmentId: first.assignmentId, nativeRequestId,
    questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "environment", prompt: "Which synthetic environment?", required: true,
      answerMode: "single_select", options: [{ id: "test", label: "Test" }, { id: "production", label: "Production" }] }] } });
  const interaction = await until("actual pending native question", async () =>
    rows(await board(`/api/issues/${issueId}/interactions`)).find(row => row.kind === "ask_user_questions" && object(row.payload).runtimeRequestId === nativeRequestId) ?? {}, value => value.status === "pending");
  assert.equal(interaction.sourceRunId, runIds[0]);
  const pendingEvent = await until("durable runtime_request.created v2", async () =>
    rows(await board(`/api/heartbeat-runs/${runIds[0]}/events?limit=1000`)).find(row => {
      if (row.eventType !== "runtime_request.created") return false;
      const event = object(object(row.payload).prpEvent ?? {});
      return event.eventType === "runtime_request.created" && object(object(event.payload).request).requestId === nativeRequestId;
    }) ?? {}, value => typeof value.id === "number");
  const nativeRequest = object(object(object(object(pendingEvent.payload).prpEvent).payload).request);
  assert.equal(nativeRequest.schema, "paperclip.runtime_request.v2"); assert.equal(nativeRequest.status, "pending");
  step("native-question-pending", { runId: runIds[0], interactionId: interaction.id, nativeRequestId });
  const answered = object(await board(`/api/issues/${issueId}/interactions/${interaction.id}/respond`, "POST", {
    answers: [{ questionId: "environment", optionIds: ["test"] }] })); assert.equal(answered.status, "answered");
  const input = await until("durable answer input", () => query({ query: "input.pending", assignmentId: first.assignmentId, nativeRequestId }), value => typeof value.inputDigest === "string");
  assert.equal(input.requestId, nativeRequestId); assert.equal(input.turnId, object(first.binding).turnId);
  assert.equal(input.inputDigest, digestPaperclipSemanticContent({ requestId: nativeRequestId, turnId: input.turnId, response: input.response }));
  const resolvedEvent = await until("durable native answer resolution", async () =>
    rows(await board(`/api/heartbeat-runs/${runIds[0]}/events?limit=1000`)).find(row => {
      if (row.eventType !== "runtime_request.resolved") return false;
      const event = object(object(row.payload).prpEvent ?? {});
      return event.eventType === "runtime_request.resolved" && object(event.payload).requestId === nativeRequestId;
    }) ?? {}, value => typeof value.id === "number");
  const resolvedPayload = object(object(object(resolvedEvent.payload).prpEvent).payload);
  assert.equal(resolvedPayload.turnId, input.turnId); assert.equal(resolvedPayload.action, "submit");
  const continuationReceiptId = randomUUID(), continuationFile = join(evidenceDirectory, `continuation-${continuationReceiptId}.json`);
  await writeFile(continuationFile, JSON.stringify({ synthetic: true, continuationReceiptId, requestId: nativeRequestId,
    turnId: input.turnId, inputDigest: input.inputDigest, response: input.response }), { mode: 0o600, flag: "wx" });
  assert.equal(object(JSON.parse(await readFile(continuationFile, "utf8"))).inputDigest, input.inputDigest);
  await command({ command: "consume_input", assignmentId: first.assignmentId, nativeRequestId, inputDigest: input.inputDigest,
    continuationReceiptId, continuationPersisted: true });
  const consumed = await query({ query: "input.pending", assignmentId: first.assignmentId, nativeRequestId }); assert.equal(consumed.consumed, true);
  evidence.question = { interactionId: interaction.id, nativeRequestId, questionCommandId: `question_${interaction.id}`,
    pendingNative: true, nativeEventId: pendingEvent.id, resolvedNativeEventId: resolvedEvent.id, resolvedNativeRequestId: resolvedPayload.requestId, nativeRequestSchema: nativeRequest.schema, answeredStatus: answered.status, inputDigest: input.inputDigest, continuationReceiptId, continuationPersisted: true, consumed: true };
  step("native-question-consumed");
  await finish(first, "Saved the synthetic report and consumed the selected test environment.");
  const reopen = object(await board(`/api/issues/${issueId}/comments`, "POST", { body: `${marker}: revise the report after completed work.`, reopen: true, clientRequestId: randomUUID() }));
  const second = await assignment(); await accept(second);
  const followUp = object(await board(`/api/issues/${issueId}/comments`, "POST", { body: `${marker}: add follow-up acknowledged.`, clientRequestId: randomUUID() }));
  const mailbox = await until("active native follow-up reference", () => query({ query: "mailbox", after: 0 }), value =>
    rows(value.items).some(row => row.kind === "follow_up" && object(row.references).commentId === followUp.id));
  assert.ok(rows(mailbox.items).some(row => object(row.references).assignmentId === second.assignmentId && object(row.references).commentId === followUp.id));
  const history = await command({ command: "tool", assignmentId: second.assignmentId, name: "get_task_history", arguments: {} });
  assert.ok(rows(object(history.result).comments).some(comment => comment.id === followUp.id));
  const latest = object(await board(`/api/issues/${issueId}/documents/report`));
  const revised = `${documentBody}\nFollow-up acknowledged.\n`;
  await command({ command: "tool", assignmentId: second.assignmentId, name: "write_document", arguments: {
    key: "report", title: "Synthetic Muse report", body: revised, baseRevisionId: latest.latestRevisionId, idempotencyKey: randomUUID() } });
  assert.equal(object(await board(`/api/issues/${issueId}/documents/report`)).body, revised.trim());
  evidence.followUp = { reopenCommentId: reopen.id, activeCommentId: followUp.id, mailboxReference: true, successfulHistoryReceipt: true, reportRevised: true };
  await finish(second, "Applied the synthetic follow-up to the report.");
  await delay(1500);
  const runs = rows(await board(`/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=100`)).filter(run =>
    run.issueId === issueId || run.nativeIssueId === issueId || object(run.contextSnapshot ?? {}).issueId === issueId);
  assert.equal(runs.length, 2, "Unread follow-up must not create a third run"); assert.ok(runs.every(run => run.status === "succeeded"));
  const completedRuns = await Promise.all(runs.map(async run => object(await board(`/api/heartbeat-runs/${string(run.id)}`))));
  evidence.runs = completedRuns.map(run => ({ id: run.id, status: run.status, runtimeMode: run.runtimeMode, driverKind: run.driverKind,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    nativeInputSchema: object(object(run.runnerProfileJson).nativeExecutionInput).schema,
    finalizationPhase: object(run.resultJson ?? {}).finalizationPhase }));
  assert.equal(detectorError, false); evidence.detector = { syntheticContacts: detectorRequests, cadenceMs: 5000,
    signalMode: evidence.signalMode, secretUsed: evidence.signalMode === "authenticated_synthetic",
    realHooksInstalled: false, liveMuseCompatible: evidence.liveMuseDetectorCompatible };
  evidence.passed = true; step("passed", { nativeTurns: 2 });
} catch (error) {
  evidence.passed = false; evidence.failure = { stage, observed: error instanceof Error ? error.message : "Unknown failure", classification: "requires diagnosis" };
  process.exitCode = 1;
} finally {
  if (detectorTimer) clearInterval(detectorTimer);
  await detectorFlight;
  cleanupDeadline = Date.now() + 30_000;
  const cleanup: Json = {};
  try {
    for (const runId of runIds) {
      const run = object(await board(`/api/heartbeat-runs/${runId}`));
      if (["queued", "running"].includes(String(run.status))) await board(`/api/heartbeat-runs/${runId}/cancel`, "POST", { cancellationRequestId: randomUUID() });
    }
    if (createdBindingId) {
      const connection = object(await board(bindingPath)), binding = connection.binding ? object(connection.binding) : undefined;
      assert.equal(binding?.id, createdBindingId, "Never revoke an unrelated connection during cleanup");
      if (binding && binding.status !== "revoked") await board(`${bindingPath}/revoke`, "POST", { bindingId: binding.id, generation: binding.generation, expectedRevision: binding.revision });
    } else cleanup.noAuthorityCreated = true;
    if (credentials) await http("/api/muse/v1/detector-cleanup", "POST", { version: 1, requestId: randomUUID(), bindingId: credentials.bindingId, generation: credentials.generation, detectorRemoved: true }, string(credentials.detectorCleanupToken));
    cleanup.normalAuthorityRevoked = true; cleanup.syntheticDetectorStopped = true;
    if (createdBindingId) {
      const after = object(object(await board(bindingPath)).binding);
      assert.equal(after.id, createdBindingId);
      const stop = object(after.stop);
      cleanup.stopStatus = stop.status; cleanup.nativeEffectsUnknown = stop.nativeEffectsUnknown;
      if (stop.status !== "none" || after.uncertainOperations !== 0) cleanup.requiresOperatorReview = true;
    }
  } catch { cleanup.completed = false; cleanup.requiresOperatorReview = true; }
  evidence.cleanup = cleanup; evidence.completedAt = new Date().toISOString();
  await writeFile(join(evidenceDirectory, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ synthetic: true, passed: evidence.passed === true, stage, evidence: join(evidenceDirectory, "evidence.json"), cleanup }));
}
