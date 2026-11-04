/**
 * Provider feasibility probe only. No Paperclip access, real tasks, or production
 * credentials. A synthetic result is withheld for 60 seconds to test whether the
 * hosted voice worker keeps fetching it without another spoken user prompt.
 */
import { createHash, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Webhook } from "standardwebhooks";

export const TOOL_PATH = "/speko-proof/tool";
export const DELAY_MS = 60_000;
export const WAIT_MS = 2_500;
export const BODY_LIMIT = 32 * 1024;
const MAX_CALLS = 500;
const TTL_MS = 15 * 60_000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedId = (value) => typeof value === "string" && /^[A-Za-z0-9_:-]{1,200}$/.test(value);

export const PROOF_PROMPT = `You are a voice transport feasibility test, not a real company agent.
When the caller asks to start the test, call submit_request with their request.
Acknowledge that the work is running. Call get_updates with cursor 0 immediately.
When it returns pending, call it again using the returned cursor, without waiting
for the caller to ask. It waits briefly on the server. Do not claim completion
until get_updates returns a completed result. Do not invent a verification phrase.
Keep listening and allow the caller to interrupt while the work runs. When the
caller adds an instruction, call submit_request again; it updates the same job.
Continue get_updates after an interruption. Read the completed result aloud once.
Never interpret a pending tool response or acknowledgment as the completed result.
After the result, stop polling and let the caller end the test.`;

export function toolDefinitions(publicOrigin) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Public origin must be HTTPS without credentials, path, query, or fragment");
  }
  const source = { kind: "webhook", url: `${origin.origin}${TOOL_PATH}`, method: "POST", responseMode: "sync", timeoutMs: 3_500 };
  return [
    {
      name: "submit_request",
      description: "Start the delayed test or add an instruction to its existing job. Returns promptly; never wait for completion here.",
      parameters: { type: "object", properties: { text: { type: "string", maxLength: 4_000 } }, required: ["text"], additionalProperties: false },
      source,
    },
    {
      name: "get_updates",
      description: "Retrieve the delayed result. While pending, call again without waiting for another user message. Read a completed result aloud once.",
      parameters: { type: "object", properties: { cursor: { type: "integer", minimum: 0, maximum: 1 } }, required: ["cursor"], additionalProperties: false },
      source,
    },
  ];
}

function validateEnvelope(value) {
  if (!isRecord(value) || !boundedId(value.session_id) || !boundedId(value.tool_call_id)
    || value.idempotency_key !== `${value.session_id}:${value.tool_call_id}` || !isRecord(value.args)) return false;
  if (value.tool === "submit_request") {
    return Object.keys(value.args).length === 1 && typeof value.args.text === "string"
      && value.args.text.trim().length > 0 && value.args.text.length <= 4_000;
  }
  return value.tool === "get_updates" && Object.keys(value.args).length === 1
    && Number.isInteger(value.args.cursor) && value.args.cursor >= 0 && value.args.cursor <= 1;
}

export function createProof({ signingSecret, now = Date.now, wait = sleep, delayMs = DELAY_MS, onEvent = () => {} }) {
  // Deliberately support one explicit, current-format secret; no ambiguous
  // legacy decoding fallbacks. Rotation is a new isolated probe run.
  if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(signingSecret ?? "")) throw new Error("A generated 32-byte Standard Webhooks secret is required");
  const verifier = new Webhook(signingSecret);
  const createdAt = now();
  const receipts = new Map();
  let sessionId;
  let startedAt;
  let requests = 0;
  let result;
  let closed = false;
  const events = [];

  function emit(kind, extra = {}) {
    const event = { kind, elapsedMs: now() - createdAt, ...extra };
    events.push(event);
    onEvent(event);
  }

  async function execute(envelope) {
    if (envelope.tool === "submit_request") {
      if (result) return { status: 409, body: { error: "proof_already_completed" } };
      const first = startedAt === undefined;
      if (first) startedAt = now();
      requests += 1;
      // Never retain the caller's text, even in the local evidence file.
      emit(first ? "request_accepted" : "followup_accepted", { requestCount: requests });
      return { status: 200, body: { status: "pending", cursor: 0, requestCount: requests, message: "The test is running. Retrieve updates while we continue talking." } };
    }
    if (startedAt === undefined) {
      emit("tool_rejected", { tool: "get_updates", reason: "start_request_first" });
      return { status: 409, body: { error: "start_request_first" } };
    }
    if (envelope.args.cursor === 1 && !result) return { status: 400, body: { error: "cursor_ahead_of_result" } };
    const remaining = startedAt + delayMs - now();
    if (!result && remaining > 0) await wait(Math.min(WAIT_MS, remaining));
    if (closed || now() - createdAt >= TTL_MS) return { status: 410, body: { error: "proof_expired" } };
    if (!result && now() >= startedAt + delayMs) {
      result = { cursor: 1, text: `Paperclip proof complete. Verification number ${randomInt(1_000, 10_000)}. Follow-up count ${requests - 1}.` };
      emit("result_ready", { requestCount: requests, jobElapsedMs: now() - startedAt });
    }
    const updates = result && envelope.args.cursor < result.cursor ? [result] : [];
    emit(updates.length ? "result_returned_to_tool" : "poll_returned", { cursor: result?.cursor ?? 0 });
    return { status: 200, body: { status: result ? "completed" : "pending", cursor: result?.cursor ?? 0, updates } };
  }

  return {
    async handle(rawBody, headers) {
      if (Buffer.byteLength(rawBody) > BODY_LIMIT) return { status: 413, body: { error: "body_too_large" } };
      let envelope;
      try { envelope = verifier.verify(rawBody, headers); }
      catch { return { status: 401, body: { error: "invalid_signature" } }; }
      if (!validateEnvelope(envelope)) return { status: 400, body: { error: "invalid_envelope" } };
      if (closed || now() - createdAt >= TTL_MS) return { status: 410, body: { error: "proof_expired" } };
      // Only synthetic content exists here. First signed delivery binds this
      // single-run harness; a production connector must use server-owned sessions.
      if (sessionId && sessionId !== envelope.session_id) return { status: 403, body: { error: "different_session" } };
      const fingerprint = digest(rawBody);
      const prior = receipts.get(envelope.idempotency_key);
      if (prior) return prior.fingerprint === fingerprint ? prior.response : { status: 409, body: { error: "conflicting_retry" } };
      if (receipts.size >= MAX_CALLS) return { status: 429, body: { error: "proof_call_limit" } };
      sessionId ??= envelope.session_id;
      // Reserve before execute yields, so concurrent retries share one result.
      const response = Promise.resolve().then(() => execute(envelope));
      receipts.set(envelope.idempotency_key, { fingerprint, response });
      return response;
    },
    close() { closed = true; },
    evidence() {
      return { mode: "synthetic_provider_probe", liveQualification: "not_established", acceptedRequests: requests, expectedSyntheticResult: result?.text ?? null, resultReturned: events.some((event) => event.kind === "result_returned_to_tool"), events: structuredClone(events) };
    },
  };
}

export function createProofServer(proof) {
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, { mode: "synthetic_provider_probe" });
    if (req.method !== "POST" || req.url !== TOOL_PATH) return reply(404, { error: "not_found" });
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") return reply(415, { error: "json_required" });
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") return reply(415, { error: "encoding_not_supported" });
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > BODY_LIMIT) { reply(413, { error: "body_too_large" }); return; }
        chunks.push(chunk);
      }
      const result = await proof.handle(Buffer.concat(chunks).toString("utf8"), req.headers);
      reply(result.status, result.body);
    } catch {
      if (!res.headersSent) reply(500, { error: "proof_failed" });
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 16;
  return server;
}
