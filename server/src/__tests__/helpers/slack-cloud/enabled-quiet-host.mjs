import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { realpath, readFile } from "node:fs/promises";

const cloudRoot = await realpath(process.env.PAPERCLIP_CLOUD_REPO_ROOT ?? "");
const cloudPackage = JSON.parse(await readFile(path.join(cloudRoot, "package.json"), "utf8"));
assert.equal(cloudPackage.name, "@paperclip/cloud-harness");
const { createIdleIncomingWakeCapability } = await import(pathToFileURL(path.join(cloudRoot, "dist/sleep/incoming-wake-capability.js")).href);
const { default: pg } = await import(pathToFileURL(path.join(cloudRoot, "node_modules/pg/lib/index.js")).href);
const { PostgresCloudHarnessRegistry } = await import(pathToFileURL(path.join(cloudRoot, "dist/registry/postgres.js")).href);
const { PostgresConnectorStore } = await import(pathToFileURL(path.join(cloudRoot, "dist/connections/postgres.js")).href);
const { ConnectorBroker } = await import(pathToFileURL(path.join(cloudRoot, "dist/connections/broker.js")).href);
const { SLACK_FORM_OPERATION_BYTES } = await import(pathToFileURL(path.join(cloudRoot, "dist/connections/slack-forms.js")).href);
const { ConnectorEventDeliveryWorker, createConnectorEventNotifier } = await import(pathToFileURL(path.join(cloudRoot, "dist/connections/event-delivery.js")).href);
const { providerRegistryFromEnvironment } = await import(pathToFileURL(path.join(cloudRoot, "dist/connections/providers.js")).href);
const { handleTenantSlackForm } = await import(pathToFileURL(path.join(cloudRoot, "dist/connections/slack-form-http.js")).href);
const { handleTenantSlackEvent } = await import(pathToFileURL(path.join(cloudRoot, "dist/connections/slack-event-http.js")).href);
const { InMemoryProviderSecretStore } = await import(pathToFileURL(path.join(cloudRoot, "dist/providers/neon.js")).href);
const { FakeCloudStackProvider } = await import(pathToFileURL(path.join(cloudRoot, "dist/providers/fake.js")).href);
const { CloudStackProvisioner } = await import(pathToFileURL(path.join(cloudRoot, "dist/provisioner/provisioner.js")).href);
const { createRuntimeIdentitySignerFromEnv } = await import(pathToFileURL(path.join(cloudRoot, "dist/runtime/runtime-identity-assertion.js")).href);
assert.equal(process.versions.node.split(".")[0], "22");
assert.equal(process.argv.length, 3);
assert.ok(process.env.SLACK_FORM_FIXTURE_SCOPES?.length);
const stateFile = process.argv[2];
assert.ok(stateFile && path.isAbsolute(stateFile));
const databaseUrl = process.env.SLACK_EVENT_TEST_DATABASE_URL;
const database = new URL(databaseUrl ?? "");
assert.equal(database.protocol, "postgres:");
assert.equal(database.hostname, "127.0.0.1");
assert.match(database.port, /^[0-9]+$/, "Explicit database port required before Pool or migrations");
const databasePort = Number(database.port);
assert.ok(Number.isInteger(databasePort) && databasePort >= 1 && databasePort <= 65535);
assert.match(database.pathname, /^\/sleep2_slack_form_[a-z0-9_]+_cloud_test$/);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const registry = new PostgresCloudHarnessRegistry(pool);
const store = new PostgresConnectorStore(pool);
const secrets = new InMemoryProviderSecretStore();
const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519"), control = generateKeyPairSync("ed25519");
const controlPublic = { ...control.publicKey.export({ format: "jwk" }), kid: "slack-form-journey", use: "sig", alg: "EdDSA" };
const signer = createRuntimeIdentitySignerFromEnv({
  CLOUD_HARNESS_RUNTIME_IDENTITY_SIGNING_JWK: JSON.stringify({ ...control.privateKey.export({ format: "jwk" }), kid: controlPublic.kid, use: "sig", alg: "EdDSA" }),
  CLOUD_HARNESS_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [controlPublic] }),
}, { required: true });
assert.ok(signer?.signControlAssertion);
const fixture = {
  companyId: randomUUID(), endpointId: randomUUID(), connectionId: randomUUID(), applicationId: randomUUID(), agentId: randomUUID(),
  actorId: `form-owner-${randomUUID()}`, instanceId: `form-stack-${randomUUID()}`, publicId: randomBytes(32).toString("base64url"),
  teamId: "TTEST", appId: "ATEST", botId: "UBOT", userId: "UOPERATOR", channelId: "CTEST", threadTs: "1788.100000",
  botToken: "xoxb-controlled-journey-only", signingSecret: randomBytes(16).toString("hex"), controlNonce: randomBytes(32).toString("base64url"),
  signPrivate: signing.privateKey.export({ format: "jwk" }).d, sealPrivate: sealing.privateKey.export({ format: "jwk" }).d,
  controlJwks: { keys: [controlPublic] },
};
const failures = [], calls = [], views = new Map(), triggers = new Map(), postedMessages = new Map();
const faults = { dropImmediateHint: false, loseTerminalReply: false, loseAckReply: false };
let tenantOrigin = process.env.SLACK_FORM_FIXTURE_PEER_ORIGIN, broker, worker, stopping = false, wakerStarts = 0, droppedHints = 0, lostTerminalReplies = 0, lostAckReplies = 0;
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(body)); };
const read = async req => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert.ok(size <= 2_100_000); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
};
const loopback = value => { const url = new URL(value); assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/"); return url.origin; };
tenantOrigin = loopback(tenantOrigin);
fixture.tenantOrigin = tenantOrigin;
const notification = createConnectorEventNotifier({
  getStack: async id => {
    assert.equal(id, fixture.instanceId);
    const stack = await registry.getStack(id);
    if (!stack || !tenantOrigin) return undefined;
    return { id: stack.id, lifecycleState: stack.lifecycleState, providerRefs: [{ provider: "railway", resourceType: "service_domain:web", resourceId: "fixture-tenant", name: "tenant.example", metadata: { upstreamOrigin: tenantOrigin } }] };
  },
  wake: async id => { assert.equal(id, fixture.instanceId); return { status: "awake" }; },
  sign: input => signer.signControlAssertion(input),
});
const hint = async () => { const instance = await store.getInstance(fixture.instanceId); assert.ok(instance); await notification(instance); };
const restartWaker = async () => {
  await worker?.stop();
  worker = new ConnectorEventDeliveryWorker({ store, deliver: notification, onError: error => failures.push(String(error?.stack ?? error)) });
  wakerStarts++; worker.start();
};
// PRIVATE controlled-provider wire witnesses: never derive from App rows/ACKs.
const wireRequests = new WeakMap();
const receivedSessionStatuses = new Map();
const wireMethods = new Set(["auth.test", "users.info", "conversations.info", "conversations.list", "conversations.open", "conversations.history", "conversations.replies",
  "reactions.add", "reactions.remove", "chat.update", "chat.postEphemeral", "chat.postMessage", "chat.scheduleMessage", "chat.deleteScheduledMessage", "chat.delete",
  "chat.startStream", "chat.appendStream", "chat.stopStream", "agents.sessions.setStatus", "assistant.threads.setStatus", "assistant.threads.setTitle", "assistant.threads.setSuggestedPrompts", "views.open", "views.update"]);
function usefulReplyWitness(message) {
  if (message.channel !== fixture.channelId || message.user !== fixture.botId || !postedMessages.has(message.ts)
    || ![fixture.threadTs, (Number(fixture.threadTs) + 1).toFixed(6)].includes(message.thread_ts)) return null;
  // The pinned SDK sends markdown_text exclusively for {markdown}; raw/string
  // messages use text. Do not scan unrelated JSON/metadata for an apparent run.
  let text;
  if (typeof message.markdown_text === "string") {
    if (message.text !== undefined || message.blocks !== undefined) return null;
    text = message.markdown_text;
  } else if (typeof message.text === "string" && message.blocks === undefined) text = message.text;
  else return null;
  const match = /^Scoped Slack useful reply for run ([a-f0-9-]{36})$/.exec(text);
  if (!match || match[0] !== text) return null;
  return { id: message.ts, threadTs: message.thread_ts, runId: match[1] };
}
function wireSourceFrames(error) {
  return String(error?.stack ?? "").split("\n").slice(1, 9).flatMap(frame => {
    const match = /slack-form-journey-host\.mjs:(\d+):(\d+)/.exec(frame);
    return match ? [`controlled-provider:${match[1]}:${match[2]}`] : [];
  });
}
const platform = async (req, res, pathname) => {
  const raw = await read(req), encoding = req.headers["content-type"] ?? "";
  const body = encoding.includes("application/json") ? JSON.parse(raw.toString()) : Object.fromEntries(new URLSearchParams(raw.toString()));
  if (typeof body.view === "string") body.view = JSON.parse(body.view);
  const method = pathname.slice("/fixture/slack/".length);
  assert.ok(req.method === "POST" || req.method === "GET" && method === "conversations.list", "fixture_method_contract");
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? body.token;
  assert.equal(token, fixture.botToken);
  wireRequests.set(req, { method: wireMethods.has(method) ? method : "unsupported-slack-method", methodDigest: createHash("sha256").update(method).digest("hex"),
    ownedProviderId: typeof body.ts === "string" && postedMessages.has(body.ts) ? body.ts
      : typeof body.oldest === "string" && postedMessages.has(body.oldest) ? body.oldest : null });
  calls.push({ method, at: Date.now(), ...(method.startsWith("views.") ? { body } : {}) });
  if (method === "auth.test") {
    res.setHeader("x-oauth-scopes", process.env.SLACK_FORM_FIXTURE_SCOPES ?? "");
    return json(res, 200, { ok: true, team_id: fixture.teamId, user_id: fixture.botId, user: "fixture" });
  }
  if (method === "users.info") return json(res, 200, { ok: true, user: { id: fixture.userId, name: "operator", is_bot: false, profile: { display_name: "Operator" } } });
  if (method === "conversations.info") return json(res, 200, { ok: true, channel: { id: fixture.channelId, name: "fixture", is_member: true } });
  if (method === "conversations.list") return json(res, 200, { ok: true, channels: [{ id: fixture.channelId, name: "fixture", is_member: true }], response_metadata: { next_cursor: "" } });
  if (method === "agents.sessions.setStatus") {
    // Exact production setSlackSessionStatus wire contract; record the real
    // idempotent effect before acknowledging it. Never settle App rows here.
    assert.equal(req.method, "POST"); assert.ok(encoding.includes("application/json"));
    assert.deepEqual(Object.keys(body).sort(), ["channel_id", "status", "thread_ts"]);
    assert.equal(body.channel_id, fixture.channelId);
    assert.ok([fixture.threadTs, (Number(fixture.threadTs) + 1).toFixed(6)].includes(body.thread_ts));
    assert.ok(["processing", "active", "suspended", "closed"].includes(body.status));
    const previous = receivedSessionStatuses.get(body.thread_ts) ?? null;
    receivedSessionStatuses.set(body.thread_ts, body.status);
    console.info(JSON.stringify({ event: "controlled-slack-session-status-received", method,
      methodDigest: createHash("sha256").update(method).digest("hex"), status: 200,
      ownedChannel: true, ownedThreadTs: body.thread_ts, previousStatus: previous, sessionStatus: body.status,
      effectRecordedBeforeAcknowledgement: receivedSessionStatuses.get(body.thread_ts) === body.status }));
    return json(res, 200, { ok: true });
  }
  if (["reactions.add", "reactions.remove", "chat.update", "chat.postEphemeral"].includes(method)) return json(res, 200, { ok: true, ts: fixture.threadTs, channel: fixture.channelId });
  if (method === "chat.postMessage") {
    assert.equal(body.channel, fixture.channelId);
    const ts = `1788.${String(200000 + calls.length).padStart(6, "0")}`;
    const message = { ...body, ts, user: fixture.botId };
    postedMessages.set(ts, message);
    const witness = usefulReplyWitness(message);
    console.info(JSON.stringify({ event: "controlled-slack-message-received", method: "chat.postMessage", status: 200,
      ownedProviderId: ts, ownedChannel: message.channel === fixture.channelId,
      ownedThread: [fixture.threadTs, (Number(fixture.threadTs) + 1).toFixed(6)].includes(message.thread_ts),
      contentField: typeof message.markdown_text === "string" ? "markdown_text" : typeof message.text === "string" ? "text" : "other",
      exactUsefulText: witness !== null, usefulRunId: witness?.runId ?? null,
      contentDigest: typeof message.markdown_text === "string" || typeof message.text === "string"
        ? createHash("sha256").update(message.markdown_text ?? message.text).digest("hex") : null }));
    return json(res, 200, { ok: true, ts, channel: fixture.channelId, message });
  }
  if (method === "conversations.replies") {
    assert.equal(body.channel, fixture.channelId);
    assert.ok([fixture.threadTs, (Number(fixture.threadTs) + 1).toFixed(6)].includes(body.ts));
    assert.equal(body.limit, "1");
    assert.equal(body.inclusive, "true");
    assert.equal(body.cursor, undefined);
    assert.equal(body.latest, undefined);
    assert.equal(typeof body.oldest, "string");
    const message = postedMessages.get(body.oldest);
    assert.ok(message, "only a message created by this fixture's real chat.postMessage may be fetched");
    assert.equal(message.thread_ts, body.ts);
    if (Object.hasOwn(body, "token")) assert.equal(body.token, fixture.botToken);
    assert.deepEqual(Object.keys(body).filter(key => key !== "token").sort(), ["channel", "inclusive", "limit", "oldest", "ts"]);
    return json(res, 200, { ok: true, messages: [message], has_more: false, response_metadata: { next_cursor: "" } });
  }
  if (method === "views.open") {
    const deadline = triggers.get(body.trigger_id);
    assert.ok(deadline, "only the original issued trigger may open a view");
    triggers.delete(body.trigger_id);
    if (Date.now() >= deadline) return json(res, 200, { ok: false, error: "expired_trigger_id" });
    const targets = await pool.query("SELECT delivery_id FROM cloud_harness.connector_webhook_delivery_targets WHERE connector_instance_id=$1 AND status<>'acknowledged'", [fixture.instanceId]);
    assert.equal(targets.rows.length, 1, "the original target must be durable before trigger spend");
    assert.equal(body.view.notify_on_close, true);
    assert.ok(!body.view.blocks.some(block => block.type === "input"));
    assert.equal(body.view.callback_id, "paperclip_slack_form_loading_v1");
    const view = { ...body.view, id: "VJOURNEY", hash: "loading-hash", app_id: fixture.appId, state: { values: {} } };
    views.set(view.id, view); return json(res, 200, { ok: true, view });
  }
  if (method === "views.update") {
    const old = views.get(body.view_id); assert.ok(old);
    assert.equal(body.hash, old.hash); assert.equal(body.view.external_id, old.external_id);
    assert.equal(body.view.notify_on_close, true); assert.ok(body.view.blocks.some(block => block.type === "input"));
    assert.ok(tenantOrigin);
    const response = await fetch(`${tenantOrigin}/__fixture/committed-hold`, { headers: { "x-fixture-control": fixture.controlNonce } });
    assert.equal(response.status, 200);
    const hold = await response.json();
    assert.equal(hold.status, "processing"); assert.equal(hold.phase, "update_attempted");
    assert.deepEqual(hold.view, { id: old.id, hash: old.hash, externalId: old.external_id });
    assert.equal(hold.operationId, old.external_id.slice("pc-form-".length));
    const view = { ...old, ...body.view, hash: "useful-hash" };
    views.set(view.id, view); return json(res, 200, { ok: true, view });
  }
  throw new Error(`Unexpected actual SDK request ${method}`);
};
const snapshot = async () => ({
  sessionStatuses: [...receivedSessionStatuses].map(([threadTs, status]) => ({ threadTs, status })),
  usefulReplies: [...postedMessages.values()].flatMap(message => {
    const witness = usefulReplyWitness(message);
    return witness ? [witness] : [];
  }),
  calls, views: [...views.values()], failures, wakerStarts, droppedHints, lostTerminalReplies, lostAckReplies,
  instance: await store.getInstance(fixture.instanceId),
  bindings: (await store.listWebhookBindings(fixture.instanceId)).map(row => ({ id: row.id, profile: row.profile, metadata: row.providerMetadata })),
  targets: (await pool.query("SELECT delivery_id,lease_id,lease_expires_at FROM cloud_harness.connector_webhook_delivery_targets WHERE connector_instance_id=$1 AND status<>'acknowledged' ORDER BY delivery_id", [fixture.instanceId])).rows,
});
const server = createServer((req, res) => { void (async () => {
  const url = new URL(req.url, fixture.origin);
  if (url.pathname.startsWith("/__fixture/")) {
    assert.equal(req.headers["x-fixture-control"], fixture.controlNonce);
    if (req.method === "GET" && url.pathname === "/__fixture/state") return json(res, 200, await snapshot());
    if (req.method === "POST" && url.pathname === "/__fixture/max-header") {
      assert.ok(tenantOrigin);
      const instance = await store.getInstance(fixture.instanceId); assert.ok(instance);
      const initial = await store.listWebhookBindings(fixture.instanceId);
      assert.equal(initial.length, 2);
      assert.ok(broker.slackEvents && broker.slackForms);
      for (let index = 1; index < 500; index++) {
        const event = await broker.slackEvents.enroll(instance, fixture.actorId, {
          companyId: fixture.companyId, endpointId: randomUUID(), connectionId: randomUUID(), publicId: randomBytes(32).toString("base64url"),
          runtimeGeneration: 1, teamId: fixture.teamId, appId: `AHEADER${index}`, signingSecret: randomBytes(16).toString("hex"),
        });
        await broker.slackForms.enroll(instance, fixture.actorId, event, `xoxb-controlled-header-${index}`);
      }
      const rows = await store.listWebhookBindings(fixture.instanceId); assert.equal(rows.length, 1000);
      const start = signer.signControlAssertion({ stackId: fixture.instanceId, action: "task-drain:start", requestId: randomUUID() });
      const started = await fetch(`${tenantOrigin}/api/instance/task-drain`, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", "x-paperclip-cloud-control": start }, body: JSON.stringify({ purpose: "idle", ttlMs: 30000 }), signal: AbortSignal.timeout(10000) });
      assert.equal(started.status, 200); const drain = await started.json(); assert.equal(typeof drain.ownerId, "string");
      let primary, result;
      try {
        const incomingWake = await createIdleIncomingWakeCapability({ stackId: fixture.instanceId, ownerId: drain.ownerId,
          apiEnabled: false, brokerEnabled: true, store, readSlackCoverage: id => broker.readSlackCoverage(id) });
        assert.ok(incomingWake?.slackBroker); assert.equal(incomingWake.slackBroker.entries.length, 500);
        const token = signer.signControlAssertion({ stackId: fixture.instanceId, action: "task-drain:read", requestId: randomUUID(), idleCapabilities: { incomingWake } });
        const url = `${tenantOrigin}/api/instance/task-drain?idleSleepSafety=1&idleSleepDiagnostics=1&ownerId=${encodeURIComponent(drain.ownerId)}`;
        const baseline = signer.signControlAssertion({ stackId: fixture.instanceId, action: "task-drain:read", requestId: randomUUID() });
        const tampered = baseline.slice(0, -1) + (baseline.endsWith("A") ? "B" : "A");
        const denied = await fetch(url, { headers: { "x-paperclip-cloud-control": tampered }, redirect: "error", signal: AbortSignal.timeout(10000) });
        const tamperedStatus = denied.status; await denied.arrayBuffer(); assert.equal(tamperedStatus, 401);
        const response = await fetch(url, { headers: { "x-paperclip-cloud-control": token }, redirect: "error", signal: AbortSignal.timeout(10000) });
        const raw = await response.text(); let report; try { report = JSON.parse(raw); } catch {}
        result = { bindingCount: rows.length, coverageEntries: incomingWake.slackBroker.entries.length,
          headerBytes: Buffer.byteLength(token), responseStatus: response.status, normalRouteReached: !!report?.idleSleepSafety, tamperedStatus };
        console.info(JSON.stringify({ diagnostic: "slack_form_header_wire", ...result }));
      } catch (error) { primary = error; throw error; }
      finally {
        const token = signer.signControlAssertion({ stackId: fixture.instanceId, action: "task-drain:stop", requestId: randomUUID() });
        try { const response = await fetch(`${tenantOrigin}/api/instance/task-drain?ownerId=${encodeURIComponent(drain.ownerId)}`, { method: "DELETE",
          headers: { "x-paperclip-cloud-control": token }, redirect: "error", signal: AbortSignal.timeout(10000) });
          assert.equal(response.status, 200); await response.arrayBuffer();
        } catch (error) { throw primary ? new AggregateError([primary, error], "Header preflight and normal hold cleanup failed") : error; }
      }
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/__fixture/idle-projection") {
      assert.ok(tenantOrigin);
      const request = async (method, action, suffix, body, idleCapabilities) => {
        const response = await fetch(`${tenantOrigin}/api/instance/task-drain${suffix}`, { method, redirect: "error",
          headers: { "content-type": "application/json", "x-paperclip-cloud-control": signer.signControlAssertion({ stackId: fixture.instanceId,
            action, requestId: randomUUID(), ...(idleCapabilities ? { idleCapabilities } : {}) }) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200); return await response.json();
      };
      const drain = await request("POST", "task-drain:start", "", { purpose: "idle", ttlMs: 30_000 });
      assert.equal(typeof drain.ownerId, "string");
      let primary, projection;
      try {
        const incomingWake = await createIdleIncomingWakeCapability({ stackId: fixture.instanceId, ownerId: drain.ownerId,
          apiEnabled: false, brokerEnabled: true, store, readSlackCoverage: id => broker.readSlackCoverage(id) });
        const report = await request("GET", "task-drain:read", `?idleSleepSafety=1&idleSleepDiagnostics=1&ownerId=${encodeURIComponent(drain.ownerId)}`,
          undefined, incomingWake ? { incomingWake } : undefined);
        const safety = report.idleSleepSafety; assert.ok(safety?.diagnostics);
        assert.ok(["none", "present", "unknown"].includes(safety.backgroundWork));
        assert.ok(safety.diagnostics.checks.length <= 200);
        projection = { backgroundWork: safety.backgroundWork, capabilityPresent: Boolean(incomingWake),
          checks: safety.diagnostics.checks.map(value => ({ reason: value.reason, state: value.state })) };
      } catch (error) { primary = error; throw error; }
      finally {
        try { await request("DELETE", "task-drain:stop", `?ownerId=${encodeURIComponent(drain.ownerId)}`); }
        catch (error) { throw primary ? new AggregateError([primary, error], "Idle report and hold cleanup failed") : error; }
      }
      return json(res, 200, { idleProjection: projection });
    }
    const body = JSON.parse((await read(req)).toString() || "{}");
    if (req.method === "POST" && url.pathname === "/__fixture/tenant") { assert.equal(loopback(body.origin), tenantOrigin); return json(res, 200, {}); }
    if (req.method === "POST" && url.pathname === "/__fixture/trigger") { assert.equal(typeof body.id, "string"); assert.equal(typeof body.actionTs, "string"); assert.ok(!triggers.has(body.id)); triggers.set(body.id, Number(body.actionTs) * 1000 + 3000); return json(res, 200, {}); }
    if (req.method === "POST" && url.pathname === "/__fixture/faults") { for (const key of Object.keys(body)) { assert.ok(Object.hasOwn(faults, key)); assert.equal(body[key], true); faults[key] = true; } return json(res, 200, {}); }
    if (req.method === "POST" && url.pathname === "/__fixture/restart-waker") { await restartWaker(); return json(res, 200, {}); }
    if (req.method === "POST" && url.pathname === "/__fixture/stop-waker") { await worker?.stop(); return json(res, 200, {}); }
    if (req.method === "POST" && url.pathname === "/__fixture/shutdown") { json(res, 200, await snapshot()); queueMicrotask(() => { void shutdown(); }); return; }
    throw new Error("Unknown closed fixture operation");
  }
  if (url.pathname.startsWith("/fixture/slack/")) return platform(req, res, url.pathname);
  if (url.pathname.startsWith("/v1/connector/")) {
    const loss = url.pathname === "/v1/connector/events/ack" && faults.loseAckReply;
    if (url.pathname === "/v1/connector/events/ack") {
      const original = await pool.query("SELECT delivery_id FROM cloud_harness.connector_webhook_delivery_targets WHERE connector_instance_id=$1 AND status<>'acknowledged'", [fixture.instanceId]);
      if (original.rows.some(row => row.delivery_id.startsWith("slack_form_"))) {
        assert.ok(tenantOrigin);
        const proof = await fetch(`${tenantOrigin}/__fixture/proof-accepted`, { headers: { "x-fixture-control": fixture.controlNonce } });
        assert.equal(proof.status, 200);
        const accepted = await proof.json(); assert.equal(accepted.deliveryId, original.rows.find(row => row.delivery_id.startsWith("slack_form_")).delivery_id);
        assert.equal(accepted.proof.operationId, accepted.deliveryId.slice("slack_form_".length));
        assert.ok(accepted.proof.appReceiptId);
      }
    }
    if (url.pathname === "/v1/connector/slack-forms" && faults.loseTerminalReply) {
      const end = res.end.bind(res);
      res.end = function(chunk, ...args) {
        if (typeof chunk === "string" && chunk.includes('"slackForm"') && chunk.includes('"sealed"')) {
          let requestKind;
          try { requestKind = JSON.parse(JSON.parse(Buffer.concat(captured).toString()).operation).kind; } catch {}
          if (requestKind === "terminal-ack") { faults.loseTerminalReply = false; lostTerminalReplies++; res.destroy(); return res; }
        }
        return end(chunk, ...args);
      };
      const captured = []; let capturedBytes = 0;
      const originalIterator = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = async function* () {
        for await (const chunk of originalIterator()) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); capturedBytes += buffer.byteLength;
          if (capturedBytes <= SLACK_FORM_OPERATION_BYTES + 16_000) captured.push(Buffer.from(buffer));
          yield chunk;
        }
      };
    }
    if (loss) { faults.loseAckReply = false; const end = res.end.bind(res); res.end = function(chunk, ...args) { if (res.statusCode === 200) { lostAckReplies++; res.destroy(); return res; } return end(chunk, ...args); }; }
    const handled = await broker.handle(req, res, url); assert.equal(handled, true); return;
  }
  assert.equal(url.pathname, `/api/chat-webhooks/${fixture.publicId}/slack`);
  const handled = await handleTenantSlackForm(req, res, { instanceId: fixture.instanceId, publicId: fixture.publicId, owner: broker.slackForms, ingress: broker.slackFormIngress });
  if (handled.handled) return;
  if (!handled.consumedBody) {
    const event = await handleTenantSlackEvent(req, res, { instanceId: fixture.instanceId, publicId: fixture.publicId, ingress: broker.slackEvents });
    if (event.handled) return;
    handled.consumedBody = event.consumedBody;
  }
  assert.ok(tenantOrigin);
  const upstream = await fetch(`${tenantOrigin}${url.pathname}`, { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "", "x-slack-request-timestamp": req.headers["x-slack-request-timestamp"] ?? "", "x-slack-signature": req.headers["x-slack-signature"] ?? "" }, body: handled.consumedBody ?? await read(req), redirect: "error" });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain", connection: "close" });
  res.end(Buffer.from(await upstream.arrayBuffer()));
})().catch(error => {
  const pathname = new URL(req.url ?? "/", fixture.origin ?? "http://127.0.0.1").pathname;
  const knownPaths = ["auth.test", "users.info", "conversations.info", "conversations.list", "reactions.add", "reactions.remove", "chat.update", "chat.postEphemeral", "chat.postMessage", "views.open", "views.update"].map(method => `/fixture/slack/${method}`);
  const path = knownPaths.includes(pathname) ? pathname : pathname.startsWith("/v1/connector/") ? "/v1/connector/operation" : "/tenant-webhook";
  const category = error?.message === "fixture_method_contract" ? "fixture_method_contract" : error?.code === "ERR_ASSERTION" ? "fixture_assertion" : "fixture_boundary_error";
  const wire = wireRequests.get(req);
  console.error(JSON.stringify({ event: "slack-form-fixture-boundary-failed", category,
    method: req.method === "GET" || req.method === "POST" ? req.method : "OTHER", path,
    providerMethod: wire?.method ?? "not-classified", providerMethodDigest: wire?.methodDigest ?? null, status: res.headersSent ? res.statusCode : 500,
    responseAlreadyStarted: res.headersSent, ownedProviderId: wire?.ownedProviderId ?? null,
    sourceFrames: wireSourceFrames(error) }));
  failures.push(String(error?.stack ?? error)); if (!res.headersSent) json(res, 500, { error: "fixture_boundary_failed" }); else res.destroy();
}); });
async function shutdown() {
  if (stopping) return; stopping = true;
  const errors = [];
  try { await worker?.stop(); } catch (error) { errors.push(error); }
  try { if (server.listening) { server.close(); server.closeAllConnections(); await once(server, "close"); } } catch (error) { errors.push(error); }
  try { await registry.close(); } catch (error) { errors.push(error); }
  if (errors.length) { console.error(new AggregateError(errors, "Cloud journey cleanup failed")); process.exitCode = 1; }
}
try {
  await registry.applyMigrations(path.join(cloudRoot, "migrations"), 30_000); await registry.hydrate();
  await new CloudStackProvisioner({ provider: new FakeCloudStackProvider(), registry }).provisionDevelopmentStack({
    idempotencyKey: fixture.instanceId, accountGroup: { id: `account-${fixture.instanceId}`, slug: fixture.instanceId, displayName: "Form journey" }, owner: { id: fixture.actorId, email: `${fixture.actorId}@example.test` },
    stack: { stackId: fixture.instanceId, accountGroupId: `account-${fixture.instanceId}`, stackSlug: fixture.instanceId, displayName: "Form journey", kind: "demo", primaryHost: "tenant.example", region: "us-east-1" },
    versionPlan: { appVersion: "fixture", schemaVersion: "fixture", rolloutTrack: "stable" }, sleepPolicy: { desiredState: "awake" }, primaryCompany: { paperclipCompanyId: fixture.companyId, displayName: "Form journey", defaultBudgetCents: 0 },
  });
  await store.putCloudStackInstance({ id: fixture.instanceId, kind: "cloud_stack", companyStackId: fixture.instanceId, environment: "test", ownerUserId: fixture.actorId,
    signPublicKey: signing.publicKey.export({ format: "jwk" }).x, sealPublicKey: sealing.publicKey.export({ format: "jwk" }).x,
    origins: ["https://tenant.example"], activeOrigin: "https://tenant.example", label: "Form journey", status: "active", createdAt: new Date(), updatedAt: new Date() });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string"); fixture.origin = `http://127.0.0.1:${address.port}`;
  broker = new ConnectorBroker({ publicOrigin: fixture.origin, environment: "test", store, providers: providerRegistryFromEnvironment({}, "test"), secrets: { resolve: async () => undefined },
    formReceiptAuthority: signer,
    authenticate: async () => ({ globalUserId: fixture.actorId }), slackEvents: { secrets, secretRefPrefix: "secret:///test/form-journey" }, eventWakeEnrollmentEnabled: true, eventWakeDeliveryEnabled: true,
    wakeCloudStack: async () => { if (faults.dropImmediateHint) { faults.dropImmediateHint = false; droppedHints++; return; } await hint(); },
    fetchImplementation: async (input, init) => { const url = new URL(input instanceof Request ? input.url : String(input)); assert.equal(url.origin, "https://slack.com"); assert.equal(url.pathname, "/api/views.open"); return fetch(`${fixture.origin}/fixture/slack/views.open`, init); },
  });
  await restartWaker();
  await writeFile(stateFile, JSON.stringify(fixture), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ event: "slack-form-host-ready", pid: process.pid, node: process.version, origin: fixture.origin, poolMax: 2 }));
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
} catch (error) { console.error(error); process.exitCode = 1; await shutdown(); }
