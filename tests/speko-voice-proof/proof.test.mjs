import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { Webhook } from "standardwebhooks";
import { BODY_LIMIT, createProof, createProofServer, TOOL_PATH, toolDefinitions, WAIT_MS } from "./proof.mjs";

const secret = () => `whsec_${randomBytes(32).toString("base64")}`;
function fixture(options = {}) {
  const signingSecret = secret();
  const proof = createProof({ signingSecret, ...options });
  const signer = new Webhook(signingSecret);
  let sequence = 0;
  function request(tool, args, { session = "session_1", call = `call_${++sequence}`, timestamp = new Date(), signing = signer } = {}) {
    const body = JSON.stringify({ tool, args, session_id: session, tool_call_id: call, idempotency_key: `${session}:${call}` });
    const id = `${session}:${call}`;
    const headers = { "webhook-id": id, "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "webhook-signature": signing.sign(id, timestamp, body) };
    return { body, headers, send: () => proof.handle(body, headers) };
  }
  return { proof, request };
}

test("requires HTTPS and keeps each fetch below the four-second provider limit", () => {
  for (const origin of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?key=secret"]) {
    assert.throws(() => toolDefinitions(origin));
  }
  const tools = toolDefinitions("https://example.com");
  assert.equal(tools.length, 2);
  assert.ok(tools.every(({ source }) => source.timeoutMs < 4000 && source.timeoutMs > WAIT_MS && !source.secret));
});

test("rejects missing, wrong, stale, future and tampered signatures", async () => {
  const { proof, request } = fixture();
  const valid = request("submit_request", { text: "synthetic request" });
  assert.equal((await proof.handle(valid.body, {})).status, 401);
  assert.equal((await proof.handle(valid.body + " ", valid.headers)).status, 401);
  for (const options of [{ signing: new Webhook(secret()) }, { timestamp: new Date(Date.now() - 360_000) }, { timestamp: new Date(Date.now() + 360_000) }]) {
    assert.equal((await request("submit_request", { text: "test" }, options).send()).status, 401);
  }
  assert.equal(proof.evidence().acceptedRequests, 0);
});

test("deduplicates concurrent retries and rejects changed arguments and session substitution", async () => {
  const { proof, request } = fixture();
  const original = request("submit_request", { text: "private phrase" }, { call: "same" });
  const responses = await Promise.all([original.send(), original.send(), original.send()]);
  assert.ok(responses.every((response) => response.body.requestCount === 1));
  assert.equal((await request("submit_request", { text: "changed" }, { call: "same" }).send()).status, 409);
  assert.equal((await request("submit_request", { text: "test" }, { session: "other" }).send()).status, 403);
  assert.equal(proof.evidence().acceptedRequests, 1);
  assert.ok(!JSON.stringify(proof.evidence()).includes("private phrase"));
});

test("waits 60 seconds, admits follow-ups to one job and distinguishes result retrieval from speech", async () => {
  let clock = 0;
  const waits = [];
  const { proof, request } = fixture({ now: () => clock, wait: async (duration) => { waits.push(duration); clock += duration; } });
  assert.equal((await request("get_updates", { cursor: 0 }).send()).status, 409);
  assert.equal((await request("submit_request", { text: "start" }).send()).body.status, "pending");
  assert.equal((await request("get_updates", { cursor: 1 }).send()).status, 400);
  let response;
  for (let i = 0; i < 24; i++) {
    if (i === 6) assert.equal((await request("submit_request", { text: "followup" }).send()).body.requestCount, 2);
    response = await request("get_updates", { cursor: 0 }).send();
    if (i < 23) assert.equal(response.body.status, "pending");
  }
  assert.equal(clock, 60_000);
  assert.ok(waits.every((duration) => duration <= 2500));
  assert.equal(response.body.status, "completed");
  assert.match(response.body.updates[0].text, /Verification number \d{4}\. Follow-up count 1/);
  assert.deepEqual((await request("get_updates", { cursor: 1 }).send()).body.updates, []);
  assert.equal(proof.evidence().liveQualification, "not_established");
  assert.equal(proof.evidence().resultReturned, true);
});

test("close during a bounded wait prevents further result delivery", async () => {
  let release;
  const { proof, request } = fixture({ wait: () => new Promise((resolve) => { release = resolve; }) });
  await request("submit_request", { text: "start" }).send();
  const polling = request("get_updates", { cursor: 0 }).send();
  await Promise.resolve();
  proof.close();
  release();
  assert.equal((await polling).status, 410);
  assert.equal((await request("submit_request", { text: "late" }).send()).status, 410);
});

test("expires the single-run receiver and caps authenticated deliveries", async () => {
  let clock = 0;
  const { proof, request } = fixture({ now: () => clock });
  for (let i = 0; i < 500; i++) {
    assert.equal((await request("submit_request", { text: "synthetic" }).send()).status, 200);
  }
  assert.equal((await request("submit_request", { text: "over limit" }).send()).status, 429);
  clock = 15 * 60_000;
  assert.equal((await request("submit_request", { text: "expired" }).send()).status, 410);
  assert.equal(proof.evidence().acceptedRequests, 500);
});

test("rejects invalid args and bodies before accepting work", async () => {
  const { proof, request } = fixture();
  for (const [tool, args] of [["unknown", {}], ["submit_request", { text: "" }], ["submit_request", { text: "ok", authority: "admin" }], ["get_updates", { cursor: -1 }], ["get_updates", { cursor: 0.5 }]]) {
    assert.equal((await request(tool, args).send()).status, 400);
  }
  assert.equal((await proof.handle("x".repeat(BODY_LIMIT + 1), {})).status, 413);
  assert.equal(proof.evidence().acceptedRequests, 0);
});

test("HTTP surface only accepts JSON on the signed tool route", async (t) => {
  const { proof, request } = fixture();
  const server = createProofServer(proof);
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/companies`)).status, 404);
  assert.equal((await fetch(`${base}${TOOL_PATH}`, { method: "POST", body: "{}" })).status, 415);
  const signed = request("submit_request", { text: "start" });
  const response = await fetch(`${base}${TOOL_PATH}`, { method: "POST", headers: { ...signed.headers, "content-type": "application/json" }, body: signed.body });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).requestCount, 1);
});
