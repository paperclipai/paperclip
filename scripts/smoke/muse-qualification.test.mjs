import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
const companyId = "10000000-0000-4000-8000-000000000001", agentId = "20000000-0000-4000-8000-000000000001";
const bindingId = "30000000-0000-4000-8000-000000000001", issueId = "40000000-0000-4000-8000-000000000001";
const root = resolve(import.meta.dirname, "../..");
async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), "muse-qualification-fixture-"));
  const statePath = join(directory, "state.json"), authPath = join(directory, "auth.json");
  const requests = []; let qualification; let lostCreate = true; let issue; let failEvidence = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString(); const body = input ? JSON.parse(input) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    assert.equal(req.headers.authorization, "Bearer synthetic-board-credential");
    res.setHeader("Content-Type", "application/json");
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.url.includes("/qualification")) {
      if (req.method === "POST") {
        const now = Date.now();
        qualification ??= { qualificationId: body.qualificationId, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), revision: 3 };
        return send(201, qualification);
      }
      if (req.method === "DELETE") { res.statusCode = 204; return res.end(); }
      if (failEvidence) return send(503, { error: "synthetic_unavailable" });
      return send(200, { ...qualification, stoppedAt: null, deadlineEnforcedAt: null, authorityRevoked: false,
        persistenceLagMs: 30000, cadenceEvidenceComplete: false, contacts: [], assignments: [], idleWindows: [] });
    }
    if (req.method === "GET" && req.url.endsWith("/muse-binding")) return send(200, {
      enabled: true, binding: { id: bindingId, generation: 1, revision: 2, status: "ready", backgroundReplyVerified: true,
        liveAssignments: 0, uncertainOperations: 0, pendingInputs: 0, lastReceiverContactAt: new Date().toISOString(), stop: { status: "none", nativeEffectsUnknown: false } },
    });
    if (req.method === "POST" && req.url === `/api/companies/${companyId}/issues`) {
      issue ??= { id: issueId, createdAt: new Date().toISOString(), key: body.idempotencyKey };
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
  try { await action({ run, requests, statePath, setFailEvidence: () => { failEvidence = true; } }); }
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
