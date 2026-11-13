import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { qualificationReport } from "./muse-qualification-report.mjs";
const companyId = "10000000-0000-4000-8000-000000000001", agentId = "20000000-0000-4000-8000-000000000001";
const bindingId = "30000000-0000-4000-8000-000000000001", issueId = "40000000-0000-4000-8000-000000000001";
const assignmentId = "50000000-0000-4000-8000-000000000001", runId = "60000000-0000-4000-8000-000000000001";
const HOUR = 3_600_000;
const root = resolve(import.meta.dirname, "../..");
async function fixture(action, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "muse-qualification-fixture-"));
  const statePath = join(directory, "state.json"), authPath = join(directory, "auth.json");
  const requests = [], issues = new Map(); let qualification; let lostCreate = options.lostCreate ?? true; let failEvidence = false;
  const model = { detectorCleanup: null, assignments: [], run: null, runFailureStatus: 0, issueStatus: "blocked", document: "Synthetic sample report.",
    connection: { enabled: true, binding: { id: bindingId, generation: 1, revision: 2, status: "ready", backgroundReplyVerified: true,
      credentialState: "active", refreshExpiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
      liveAssignments: 0, uncertainOperations: 0, pendingInputs: 0, lastReceiverContactAt: new Date().toISOString(),
      cleanup: { detectorRemovalRequested: false, detectorRemoved: false },
      stop: { status: "none", nativeEffectsUnknown: false } } } };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString(); const body = input ? JSON.parse(input) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    assert.equal(req.headers.authorization, "Bearer synthetic-board-credential");
    res.setHeader("Content-Type", "application/json");
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.url.includes("/qualification")) {
      if (req.method === "POST") {
        const now = Date.now() - (options.hour ?? 0) * HOUR;
        model.connection.binding.qualification = { id: body.qualificationId };
        qualification ??= { qualificationId: body.qualificationId, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), revision: 3 };
        return send(201, qualification);
      }
      if (req.method === "DELETE") { res.statusCode = 204; return res.end(); }
      if (failEvidence) return send(503, { error: "synthetic_unavailable" });
      return send(200, { ...qualification, stoppedAt: null, deadlineEnforcedAt: null, authorityRevoked: false,
        detectorCleanup: model.detectorCleanup, persistenceLagMs: 30000, cadenceEvidenceComplete: false, contacts: [], assignments: model.assignments, idleWindows: [] });
    }
    if (req.method === "GET" && req.url.endsWith("/muse-binding")) return send(200, model.connection);
    if (req.method === "GET" && req.url === "/api/heartbeat-runs/" + runId) return send(model.runFailureStatus || 200, model.run);
    if (req.method === "GET" && req.url === "/api/issues/" + issueId) return send(200, { status: model.issueStatus });
    if (req.method === "GET" && req.url === "/api/issues/" + issueId + "/documents/report") return send(200, { body: model.document });
    if (req.method === "POST" && req.url === `/api/companies/${companyId}/issues`) {
      const issue = issues.get(body.idempotencyKey) ?? { id: "40000000-0000-4000-8000-" + String(issues.size + 1).padStart(12, "0"),
        createdAt: new Date().toISOString(), key: body.idempotencyKey };
      issues.set(body.idempotencyKey, issue);
      assert.equal(body.idempotencyKey, issue.key);
      if (lostCreate) { lostCreate = false; return send(500, { error: "synthetic_lost_response" }); }
      return send(201, issue);
    }
    return send(404, { error: "unexpected_request" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  await writeFile(authPath, JSON.stringify({ version: 1, credentials: { [apiBase]: { apiBase,
    token: "synthetic-board-credential", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }), { mode: 0o600 });
  const run = command => new Promise((resolve, reject) => {
    const extra = command === "start" ? ["--api-base", apiBase, "--company-id", companyId, "--agent-id", agentId,
      "--core-revision", "a".repeat(40), "--runner-revision", "b".repeat(40), "--environment", "local", "--evidence-mode", "synthetic"] : [];
    const child = spawn(process.execPath, ["cli/node_modules/tsx/dist/cli.mjs", "scripts/smoke/muse-qualification.ts", command, "--state", statePath, ...extra], {
      cwd: root, env: { ...process.env, PAPERCLIP_AUTH_STORE: authPath }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("exit", code => resolve({ code, stdout, stderr }));
  });
  try { await action({ run, requests, statePath, model, issues,
    setQualificationTimes: (startedAt, expiresAt) => { qualification.startedAt = startedAt; qualification.expiresAt = expiresAt; },
    setFailEvidence: () => { failEvidence = true; } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}
test("qualification persists sample identity before dispatch and retries a lost create response without a new task", async () => {
  await fixture(async ({ run, requests, statePath }) => {
    const start = await run("start"); assert.equal(start.code, 0, start.stderr);
    const first = await run("check"); assert.equal(first.code, 1);
    const retained = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(retained.samples.length, 1); assert.equal(retained.samples[0].slot, 0); assert.equal(retained.samples[0].issueId, undefined);
    assert.equal(JSON.stringify(retained).includes("synthetic-board-credential"), false);
    const retry = await run("check"); assert.equal(retry.code, 0, retry.stderr);
    const report = JSON.parse(retry.stdout); assert.equal(report.qualificationPassed, false); assert.equal(report.provenance.mode, "synthetic_or_unspecified");
    const third = await run("check"); assert.equal(third.code, 0, third.stderr);
    const creates = requests.filter(item => item.method === "POST" && item.path.endsWith("/issues"));
    assert.equal(creates.length, 2); assert.equal(creates[0].body.idempotencyKey, creates[1].body.idempotencyKey);
    const state = JSON.parse(await readFile(statePath, "utf8")); assert.equal(state.samples[0].issueId, issueId);
  });
});
test("deadline cleanup occurs before evidence reads and remains recorded after a read failure", async () => {
  await fixture(async ({ run, requests, statePath, setFailEvidence }) => {
    assert.equal((await run("start")).code, 0);
    const state = JSON.parse(await readFile(statePath, "utf8")); state.expiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 }); setFailEvidence();
    const before = requests.length; const result = await run("check"); assert.equal(result.code, 1);
    assert.equal(requests[before].method, "DELETE"); assert.equal(requests[before].body.qualificationId, state.qualificationId);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).stopped, true);
    assert.equal(requests.some(item => item.path.endsWith("/issues")), false);
  });
});

async function seedFailedSample(context) {
  const start = await context.run("start"); assert.equal(start.code, 0, start.stderr);
  const state = JSON.parse(await readFile(context.statePath, "utf8"));
  const queued = Date.parse(state.startedAt) + 1000;
  const assignment = { id: assignmentId, issueId, runId, status: "fenced", offeredAt: new Date(queued + 1000).toISOString(),
    claimedAt: null, nativeAcceptedAt: null, acceptedResultAt: null, finalizedAt: null };
  const run = { id: runId, companyId, agentId, nativeIssueId: issueId, status: "failed", runtimeMode: "native",
    finishedAt: new Date(queued + 600_000).toISOString(), errorCode: "native_provider_terminal_failed" };
  state.samples.push({ slot: 0, issueId, queuedAt: new Date(queued).toISOString(), unattended: true, attempts: 1 });
  context.model.assignments = [assignment]; context.model.run = run;
  context.issues.set("muse-qualification:" + state.qualificationId + ":0", { id: issueId, createdAt: state.samples[0].queuedAt });
  await writeFile(context.statePath, JSON.stringify(state), { mode: 0o600 });
  return { state, assignment, run };
}
test("terminal unclaimed native failure preserves the failed slot and permits only the distinct current hour", async () => {
  await fixture(async context => {
    const prior = await seedFailedSample(context);
    const result = await context.run("check"); assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(await readFile(context.statePath, "utf8"));
    assert.deepEqual(state.samples.map(sample => sample.slot), [0, 5]);
    assert.equal(state.samples[0].issueId, issueId); assert.equal(state.samples[0].assignmentId, assignmentId);
    assert.equal(state.samples[0].runId, runId); assert.equal(state.samples[0].queuedAt, prior.state.samples[0].queuedAt);
    assert.equal(state.samples[0].offeredAt, prior.assignment.offeredAt); assert.equal(state.samples[0].terminalFailureAt, prior.run.finishedAt);
    assert.equal(state.samples[0].verdict, "terminal_failure"); assert.equal(state.samples[0].nativeSucceeded, false);
    assert.equal(state.samples[0].claimedAt, undefined); assert.equal(state.samples[0].nativeAcceptedAt, undefined);
    assert.equal(state.samples[0].finalizedAt, undefined); assert.equal(state.samples[0].attempts, 1);
    assert.notEqual(state.samples[1].issueId, issueId);
    const creates = context.requests.filter(item => item.method === "POST" && item.path.endsWith("/issues"));
    assert.equal(creates.length, 1); assert.equal(creates[0].body.idempotencyKey, "muse-qualification:" + state.qualificationId + ":5");
    assert.equal(context.requests.some(item => item.path.endsWith("/documents/report")), false);
    const report = JSON.parse(result.stdout); assert.equal(report.qualificationPassed, false);
    assert.equal(report.samples[0].verdict, "terminal_failure"); assert.equal(report.samples[0].terminalFailureAt, prior.run.finishedAt);
    const repeated = await context.run("check"); assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(context.requests.filter(item => item.method === "POST" && item.path.endsWith("/issues")).length, 1);
  }, { hour: 5, lostCreate: false });
});
for (const [name, change] of [
  ["claimed assignment", c => c.model.assignments[0].claimedAt = c.model.assignments[0].offeredAt],
  ["native accepted assignment", c => c.model.assignments[0].nativeAcceptedAt = c.model.assignments[0].offeredAt],
  ["accepted result", c => c.model.assignments[0].acceptedResultAt = c.model.assignments[0].offeredAt],
  ["finalized assignment", c => c.model.assignments[0].finalizedAt = c.model.assignments[0].offeredAt],
  ["offered assignment", c => c.model.assignments[0].status = "offered"],
  ["running native run", c => c.model.run.status = "running"],
  ["successful run without a result", c => c.model.run.status = "succeeded"],
  ["non-native run", c => c.model.run.runtimeMode = "adapter"],
  ["missing terminal timestamp", c => c.model.run.finishedAt = null],
  ["terminal timestamp before offer", c => c.model.run.finishedAt = new Date(Date.parse(c.model.assignments[0].offeredAt) - 1).toISOString()],
  ["future terminal timestamp", c => c.model.run.finishedAt = new Date(Date.now() + HOUR).toISOString()],
  ["wrong run", c => c.model.run.id = "60000000-0000-4000-8000-000000000002"],
  ["wrong company", c => c.model.run.companyId = "10000000-0000-4000-8000-000000000002"],
  ["wrong agent", c => c.model.run.agentId = "20000000-0000-4000-8000-000000000002"],
  ["wrong issue", c => c.model.run.nativeIssueId = "40000000-0000-4000-8000-000000000002"],
  ["multiple assignments", c => c.model.assignments.push({ ...c.model.assignments[0], id: "50000000-0000-4000-8000-000000000002" })],
  ["live work", c => c.model.connection.binding.liveAssignments = 1],
  ["unknown operation", c => c.model.connection.binding.uncertainOperations = 1],
  ["pending input", c => c.model.connection.binding.pendingInputs = 1],
  ["worker hold", c => c.model.connection.binding.stop.status = "cannot_confirm"],
  ["worker reported hold", c => c.model.connection.binding.stop.status = "worker_reported"],
  ["operator attested hold", c => c.model.connection.binding.stop.status = "operator_attested"],
  ["unknown native effects", c => c.model.connection.binding.stop.nativeEffectsUnknown = true],
  ["expired credential", c => c.model.connection.binding.credentialState = "expired"],
  ["disabled connection", c => c.model.connection.enabled = false],
  ["wrong binding", c => c.model.connection.binding.id = "30000000-0000-4000-8000-000000000002"],
  ["wrong generation", c => c.model.connection.binding.generation = 2],
  ["unready connection", c => c.model.connection.binding.status = "connected"],
  ["unverified background reply", c => c.model.connection.binding.backgroundReplyVerified = false],
  ["stale receiver", c => c.model.connection.binding.lastReceiverContactAt = new Date(Date.now() - 100_000).toISOString()],
]) {
  test("terminal failure cannot advance with " + name, async () => {
    await fixture(async context => {
      await seedFailedSample(context); change(context);
      await context.run("check");
      const state = JSON.parse(await readFile(context.statePath, "utf8"));
      assert.deepEqual(state.samples.map(sample => sample.slot), [0]);
      assert.equal(state.samples[0].issueId, issueId);
      assert.equal(context.requests.some(item => item.method === "POST" && item.path.endsWith("/issues")), false);
    }, { hour: 1, lostCreate: false });
  });
}
test("a saved terminal verdict cannot bypass contradictory current assignment evidence", async () => {
  await fixture(async context => {
    await seedFailedSample(context);
    assert.equal((await context.run("check")).code, 0);
    context.model.assignments.push({ ...context.model.assignments[0], id: "50000000-0000-4000-8000-000000000002" });
    const state = JSON.parse(await readFile(context.statePath, "utf8")); state.samples.pop();
    await writeFile(context.statePath, JSON.stringify(state), { mode: 0o600 });
    const before = context.requests.length; await context.run("check");
    assert.equal(context.requests.slice(before).some(item => item.method === "POST" && item.path.endsWith("/issues")), false);
    assert.equal(JSON.parse(await readFile(context.statePath, "utf8")).samples[0].verdict, "terminal_failure");
  }, { hour: 5, lostCreate: false });
});
test("a lost create response after its hour remains unresolved without catch-up or replacement", async () => {
  await fixture(async context => {
    assert.equal((await context.run("start")).code, 0);
    assert.equal((await context.run("check")).code, 1);
    const state = JSON.parse(await readFile(context.statePath, "utf8")), originalSample = structuredClone(state.samples[0]);
    assert.equal(originalSample.issueId, undefined); assert.equal(context.issues.size, 1);
    const creates = context.requests.filter(item => item.method === "POST" && item.path.endsWith("/issues"));
    assert.equal(creates.length, 1);
    state.startedAt = new Date(Date.parse(state.startedAt) - HOUR).toISOString();
    state.expiresAt = new Date(Date.parse(state.expiresAt) - HOUR).toISOString();
    context.setQualificationTimes(state.startedAt, state.expiresAt);
    await writeFile(context.statePath, JSON.stringify(state), { mode: 0o600 });
    assert.equal((await context.run("check")).code, 0);
    const retained = JSON.parse(await readFile(context.statePath, "utf8"));
    assert.deepEqual(retained.samples, [originalSample]); assert.equal(context.issues.size, 1);
    assert.equal(context.requests.filter(item => item.method === "POST" && item.path.endsWith("/issues")).length, 1);
    assert.ok(context.issues.has(creates[0].body.idempotencyKey));
  });
});
for (const hour of [6, 7, 8]) {
  test("terminal failure does not create a sample during idle hour " + hour, async () => {
    await fixture(async context => {
      await seedFailedSample(context); assert.equal((await context.run("check")).code, 0);
      assert.equal(context.requests.some(item => item.method === "POST" && item.path.endsWith("/issues")), false);
    }, { hour, lostCreate: false });
  });
}
test("the repaired checker refuses active version2 state without reads or mutation", async () => {
  await fixture(async context => {
    assert.equal((await context.run("start")).code, 0);
    const state = JSON.parse(await readFile(context.statePath, "utf8")); state.version = 2;
    const bytes = JSON.stringify(state); await writeFile(context.statePath, bytes, { mode: 0o600 });
    const before = context.requests.length;
    for (const command of ["check", "stop", "report"]) {
      const result = await context.run(command); assert.equal(result.code, 1);
      assert.match(result.stderr, /Unsupported qualification state/);
      assert.equal(await readFile(context.statePath, "utf8"), bytes);
    }
    assert.equal(context.requests.length, before);
  });
});

test("a later changed failure timestamp cannot replace the original terminal evidence", async () => {
  await fixture(async context => {
    const prior = await seedFailedSample(context); assert.equal((await context.run("check")).code, 0);
    const state = JSON.parse(await readFile(context.statePath, "utf8")); state.samples.pop();
    await writeFile(context.statePath, JSON.stringify(state), { mode: 0o600 });
    const originalOfferedAt = prior.assignment.offeredAt;
    context.model.assignments[0].offeredAt = new Date(Date.parse(originalOfferedAt) + 1).toISOString();
    const before = context.requests.length; const result = await context.run("check"); assert.equal(result.code, 1);
    assert.match(result.stderr, /Sample timestamp changed/);
    const retained = JSON.parse(await readFile(context.statePath, "utf8"));
    assert.equal(retained.samples[0].offeredAt, originalOfferedAt);
    assert.equal(retained.samples[0].terminalFailureAt, prior.run.finishedAt);
    assert.equal(context.requests.slice(before).some(item => item.method === "POST" && item.path.endsWith("/issues")), false);
  }, { hour: 5, lostCreate: false });
});
test("expiry revokes before failed-sample run reads and persists cleanup when that read fails", async () => {
  await fixture(async context => {
    await seedFailedSample(context); context.model.runFailureStatus = 503;
    const before = context.requests.length; const result = await context.run("check"); assert.equal(result.code, 1);
    assert.equal(context.requests[before].method, "DELETE");
    assert.ok(context.requests.slice(before).some(item => item.path === "/api/heartbeat-runs/" + runId));
    assert.equal(JSON.parse(await readFile(context.statePath, "utf8")).stopped, true);
    assert.equal(context.requests.some(item => item.method === "POST" && item.path.endsWith("/issues")), false);
  }, { hour: 25, lostCreate: false });
});
test("retaining one failed slot still fails the unchanged grader after twenty later native successes", () => {
  const start = Date.UTC(2099, 0, 1), expiry = start + 24 * HOUR, iso = value => new Date(value).toISOString();
  const samples = Array.from({ length: 24 }, (_, slot) => slot).filter(slot => slot < 6 || slot >= 9).map(slot => {
    const queued = start + slot * HOUR;
    return { slot, queuedAt: iso(queued), offeredAt: iso(queued + 1000), claimedAt: iso(queued + 2000),
      nativeAcceptedAt: iso(queued + 3000), acceptedResultAt: iso(queued + 9000), finalizedAt: iso(queued + 10000),
      nativeSucceeded: true, unattended: true, attempts: 1, documentSha256: "c".repeat(64) };
  });
  const evidence = { qualification: { startedAt: iso(start), expiresAt: iso(expiry), requestedPollIntervalMs: 5000, deadlineEnforcedAt: iso(expiry + 1000) },
    provenance: { coreRevision: "a".repeat(40), runnerRevision: "b".repeat(40), protocolVersion: 1, mode: "live", profile: "muse-personal", environment: "local" },
    samples, cadence: { from: iso(start), to: iso(expiry), observedIntervals: 17279, withinSevenSeconds: 17279,
      missingIntervals: 0, maxUnobservedGapMs: 0, complete: true },
    idleWindows: [{ from: iso(start + 6 * HOUR), to: iso(start + 9 * HOUR), coverageComplete: true, healthy: true,
      activeAssignments: 0, unconsumedInputs: 0 }],
    cleanup: { authorityRevoked: true, detectorRemovalRequested: true, detectorRemoved: true, detectorEvidenceSource: "authenticated_worker_report", detectorEvidenceRecordedAt: iso(expiry + 1000), detectorObservationAt: iso(expiry + 1000), workerStopUnconfirmed: false, nativeEffectsUnknown: false }, interventions: [] };
  assert.equal(qualificationReport(evidence, expiry + 2000).qualificationPassed, true);
  samples[0] = { slot: 0, queuedAt: samples[0].queuedAt, offeredAt: samples[0].offeredAt,
    nativeSucceeded: false, verdict: "terminal_failure", terminalFailureAt: iso(start + 600_000), unattended: true, attempts: 1 };
  const report = qualificationReport(evidence, expiry + 2000);
  assert.equal(report.successfulNativeTasks, 20); assert.equal(report.samples.length, 21);
  assert.equal(report.samples[0].nativeSucceeded, false); assert.equal(report.qualificationPassed, false);
  assert.ok(report.reasons.includes("insufficient_unattended_native_document_samples"));
});

test("a normally finalized native document sample remains successful and permits the current hour", async () => {
  await fixture(async context => {
    const prior = await seedFailedSample(context), offered = Date.parse(prior.assignment.offeredAt);
    Object.assign(context.model.assignments[0], { status: "settled", claimedAt: new Date(offered + 1000).toISOString(),
      nativeAcceptedAt: new Date(offered + 2000).toISOString(), acceptedResultAt: new Date(offered + 3000).toISOString(),
      finalizedAt: new Date(offered + 4000).toISOString() });
    context.model.run.status = "succeeded"; context.model.run.finishedAt = context.model.assignments[0].finalizedAt;
    context.model.issueStatus = "done";
    const result = await context.run("check"); assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(await readFile(context.statePath, "utf8"));
    assert.deepEqual(state.samples.map(sample => sample.slot), [0, 5]);
    assert.equal(state.samples[0].nativeSucceeded, true); assert.equal(state.samples[0].verdict, "succeeded");
    assert.match(state.samples[0].documentSha256, /^[a-f0-9]{64}$/); assert.equal(state.samples[0].terminalFailureAt, undefined);
    assert.equal(JSON.parse(result.stdout).successfulNativeTasks, 1);
    assert.ok(context.requests.some(item => item.path.endsWith("/documents/report")));
  }, { hour: 5, lostCreate: false });
});
for (const field of ["id", "runId"]) {
  test("a saved failed sample blocks a changed assignment " + field, async () => {
    await fixture(async context => {
      await seedFailedSample(context); assert.equal((await context.run("check")).code, 0);
      const state = JSON.parse(await readFile(context.statePath, "utf8")); state.samples.pop();
      await writeFile(context.statePath, JSON.stringify(state), { mode: 0o600 });
      context.model.assignments[0][field] = field === "id" ? "50000000-0000-4000-8000-000000000002" : "60000000-0000-4000-8000-000000000002";
      const before = context.requests.length; const result = await context.run("check"); assert.equal(result.code, 1);
      assert.match(result.stderr, /Sample assignment changed/);
      const retained = JSON.parse(await readFile(context.statePath, "utf8"));
      assert.equal(retained.samples[0].assignmentId, assignmentId); assert.equal(retained.samples[0].runId, runId);
      assert.equal(retained.samples[0].verdict, "terminal_failure");
      assert.equal(context.requests.slice(before).some(item => item.method === "POST" && item.path.endsWith("/issues")), false);
    }, { hour: 5, lostCreate: false });
  });
}

test("qualification report projects only the retained binding generation's authenticated detector cleanup", async () => {
  await fixture(async context => {
    const started = await context.run("start"); assert.equal(started.code, 0, started.stderr);
    const original = structuredClone(context.model.connection.binding), before = context.requests.length;
    const complete = { detectorRemovalRequested: true, detectorRemoved: true, privateDetail: "synthetic-cleanup-canary" };
    for (const variant of [
      { cleanup: undefined, requested: false, reported: false },
      { cleanup: {}, requested: false, reported: false },
      { cleanup: { detectorRemovalRequested: true, detectorRemoved: false }, requested: true, reported: false },
      { cleanup: { detectorRemovalRequested: false, detectorRemoved: true }, requested: false, reported: true },
      { cleanup: { detectorRemovalRequested: "true", detectorRemoved: 1 }, requested: false, reported: false },
      { cleanup: complete, requested: true, reported: true },
      { cleanup: complete, id: "30000000-0000-4000-8000-000000000002", requested: false, reported: false, uncertain: true },
      { cleanup: complete, generation: 2, requested: false, reported: false, uncertain: true },
      { absent: true, requested: false, reported: false, uncertain: true },
    ]) {
      context.model.connection.binding = variant.absent ? null : { ...original, cleanup: variant.cleanup,
        id: variant.id ?? original.id, generation: variant.generation ?? original.generation };
      const result = await context.run("report"); assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.detectorRemovalRequested, variant.requested);
      assert.equal(report.detectorRemovalReported, variant.reported);
      assert.equal(report.unresolvedRemoteWork, variant.uncertain ?? false);
      assert.equal(report.deadlineCleanupVerified, false); assert.equal(report.qualificationPassed, false);
      assert.equal(result.stdout.includes("synthetic-cleanup-canary"), false);
      for (const privateId of [companyId, agentId, bindingId]) assert.equal(result.stdout.includes(privateId), false);
    }
    assert.ok(context.requests.slice(before).every(request => request.method === "GET"));
  });
});


test("qualification projects only exact server-established detector attestation provenance", async () => {
  await fixture(async context => {
    assert.equal((await context.run("start")).code, 0);
    const state = JSON.parse(await readFile(context.statePath, "utf8"));
    const exact = { bindingId, generation: 1, qualificationId: state.qualificationId, source: "operator_runtime_attestation",
      recordedAt: new Date().toISOString(), observedAt: new Date().toISOString(), operatorId: "synthetic-private-operator", hookId: "synthetic-private-hook", hookScript: "synthetic-private-script" };
    for (const change of [{}, { bindingId: "30000000-0000-4000-8000-000000000002" }, { generation: 2 }, { qualificationId: "40000000-0000-4000-8000-000000000002" }]) {
      context.model.detectorCleanup = { ...exact, ...change };
      const result = await context.run("report"); assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.detectorEvidenceSource, Object.keys(change).length ? null : "operator_runtime_attestation");
      assert.equal(report.qualificationPassed, false);
      for (const value of [exact.operatorId, exact.hookId, exact.hookScript]) assert.equal(result.stdout.includes(value), false);
    }
  });
});
