import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdir, open } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { evalOtlpRejected, evalOtlpResponse, isEvalProjectId, validateEvalOtlpParent, validateEvalOtlpPayload, type EvalOtlpSignal } from "./eval-otlp-payload.js";

export const EVAL_OTLP_LIMITS = { maxRequests: 2048, maxRequestBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024, maxConcurrent: 4,
  maxExpandedBytes: 256 * 1024 * 1024, maxRecords: 16_384 } as const;
export const EVAL_OTLP_DEFAULT_LIMITS = { ...EVAL_OTLP_LIMITS,
  maxExpandedBytes: 16 * 1024 * 1024, maxRecords: 4096 } as const;

export async function startEvalOtlpRelay(input: {
  projectId: string; apiKey: string; campaignId: string; attemptId: string; receiptPath: string; deadlineAt: number;
  limits?: { [K in keyof typeof EVAL_OTLP_LIMITS]: number }; transport?: typeof fetch; expectedParent?: string;
}) {
  const limits = input.limits ?? EVAL_OTLP_DEFAULT_LIMITS;
  if (!isEvalProjectId(input.projectId) || !input.apiKey.trim() || /[\r\n]/.test(input.apiKey)
    || ![input.campaignId, input.attemptId].every(value => /^[A-Za-z0-9_.:-]{1,512}$/.test(value))
    || !path.isAbsolute(input.receiptPath) || !Number.isFinite(input.deadlineAt)
    || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 4 * 3_600_000
    || Object.keys(limits).sort().join(",") !== Object.keys(EVAL_OTLP_LIMITS).sort().join(",")
    || Object.entries(EVAL_OTLP_LIMITS).some(([key, maximum]) => !Number.isSafeInteger(limits[key as keyof typeof limits])
      || limits[key as keyof typeof limits] < 1 || limits[key as keyof typeof limits] > maximum)) throw new Error("Invalid eval OTLP relay policy");
  if (input.expectedParent !== undefined) validateEvalOtlpParent(input.expectedParent, input.projectId);
  await mkdir(path.dirname(input.receiptPath), { recursive: true, mode: 0o700 });
  const file = await open(input.receiptPath, "ax", 0o600);
  let writes = Promise.resolve(), poisoned = false, closed = false, quotaRecorded = false;
  const record = (value: object) => {
    writes = writes.then(async () => { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); })
      .catch(error => { poisoned = true; throw error; });
    return writes;
  };
  try { await record({ type: "policy", version: 2, sizing: "otlp-v1.9-expanded-source-json", projectId: input.projectId, campaignId: input.campaignId,
    attemptId: input.attemptId, ...(input.expectedParent === undefined ? {} : { expectedParent: input.expectedParent }), limits, deadlineAt: new Date(input.deadlineAt).toISOString(), openedAt: new Date().toISOString() }); }
  catch (error) { await file.close(); throw error; }
  const token = randomBytes(32).toString("hex");
  const pending = new Set<Promise<void>>(), controllers = new Set<AbortController>();
  const usage = { admittedRequests: 0, admittedWireBytes: 0, admittedBytes: 0, admittedExpandedBytes: 0,
    admittedRecords: 0, attemptedForwardBytes: 0, acceptedRequests: 0, incompleteRequests: 0 };
  const deny = (response: ServerResponse, status: number, code: string) => {
    if (response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: { type: "eval_otlp_relay", message: code } }));
  };
  const server = createServer((request, response) => {
    const operation = (async () => {
      const auth = typeof request.headers.authorization === "string" ? request.headers.authorization.replace(/^Bearer /, "") : "";
      if (Buffer.byteLength(auth) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(auth), Buffer.from(token))) return deny(response, 401, "unauthorized");
      if (closed || poisoned || Date.now() >= input.deadlineAt) return deny(response, 503, "relay_unavailable");
      const signal: EvalOtlpSignal | undefined = request.url === "/otel/v1/traces" ? "traces" : request.url === "/otel/v1/logs" ? "logs" : undefined;
      if (request.method !== "POST" || !signal) return deny(response, 404, "unqualified_endpoint");
      if (pending.size >= limits.maxConcurrent) return deny(response, 429, "concurrency_limit");
      const contentType = request.headers["content-type"]?.split(";")[0].trim();
      const encoding = request.headers["content-encoding"];
      if (!["application/json", "application/x-protobuf"].includes(contentType ?? "") || encoding && encoding !== "gzip" && encoding !== "identity") return deny(response, 415, "unqualified_encoding");
      let body: Buffer, parent: string, wireBytes = 0, expandedBytes = 0, recordCount = 0;
      try {
        parent = validateEvalOtlpParent(String(request.headers["x-bt-parent"] ?? `project_id:${input.projectId}`), input.projectId, input.expectedParent);
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          wireBytes += chunk.length;
          if (wireBytes > limits.maxRequestBytes) throw new Error("request_limit");
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks);
        if (encoding === "gzip") body = gunzipSync(body, { maxOutputLength: limits.maxRequestBytes });
        const validated = validateEvalOtlpPayload(body, contentType!, signal, input.projectId, input.expectedParent);
        ({ body, expandedBytes, recordCount } = validated);
        if (body.length > limits.maxRequestBytes) throw new Error("request_limit");
      } catch { return deny(response, 400, "invalid_or_oversized_payload"); }
      if (closed || poisoned || Date.now() >= input.deadlineAt) return deny(response, 503, "relay_unavailable");
      if (usage.admittedRequests >= limits.maxRequests || usage.admittedBytes + body.length > limits.maxTotalBytes
          || usage.admittedExpandedBytes + expandedBytes > limits.maxExpandedBytes
          || usage.admittedRecords + recordCount > limits.maxRecords) {
        if (!quotaRecorded) { quotaRecorded = true; await record({ type: "quota_exhausted", at: new Date().toISOString(), ...usage }); }
        return deny(response, 429, "ingestion_allowance_exhausted");
      }
      const id = randomUUID();
      usage.admittedRequests++; usage.admittedWireBytes += wireBytes; usage.admittedBytes += body.length;
      usage.admittedExpandedBytes += expandedBytes; usage.admittedRecords += recordCount;
      await record({ type: "admitted", id, signal, at: new Date().toISOString(), wireBytes, bodyBytes: body.length,
        expandedBytes, recordCount,
        payloadSha256: createHash("sha256").update(body).digest("hex") });
      const abort = new AbortController(); controllers.add(abort);
      const disconnected = () => { if (!response.writableEnded) abort.abort(); };
      response.on("close", disconnected);
      let status: number | undefined, outcome = "uncertain", rejected: number | undefined, dispatched = false;
      try {
        if (closed || poisoned || response.destroyed || Date.now() >= input.deadlineAt) throw new Error("relay_unavailable");
        dispatched = true; usage.attemptedForwardBytes += body.length;
        const upstream = await (input.transport ?? fetch)(`https://api.braintrust.dev/otel/v1/${signal}`, {
          method: "POST", redirect: "error", signal: AbortSignal.any([abort.signal,
            AbortSignal.timeout(Math.max(1, Math.min(10_000, input.deadlineAt - Date.now())))]),
          headers: { authorization: `Bearer ${input.apiKey}`, "x-bt-parent": parent, "content-type": contentType!,
            "accept-encoding": "identity", accept: "application/x-protobuf, application/json" }, body: Buffer.from(body),
        });
        status = upstream.status;
        if (!upstream.ok) { await upstream.body?.cancel(); outcome = "rejected"; throw new Error("receiver_rejected"); }
        const type = upstream.headers.get("content-type")?.split(";")[0].trim() ?? contentType!;
        if (!["application/json", "application/x-protobuf"].includes(type)) { await upstream.body?.cancel(); throw new Error("invalid_response"); }
        const reader = upstream.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (reader) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.length; if (bytes > 65_536) throw new Error("response_limit");
            chunks.push(next.value);
          }
        } finally { await reader?.cancel().catch(() => {}); }
        rejected = evalOtlpRejected(Buffer.concat(chunks), type, signal);
        outcome = rejected ? "partial" : "accepted";
      } catch { if (!dispatched) outcome = "not_dispatched"; }
      finally { controllers.delete(abort); response.off("close", disconnected); }
      if (outcome === "accepted") usage.acceptedRequests++; else usage.incompleteRequests++;
      await record({ type: "outcome", id, at: new Date().toISOString(), outcome, dispatched,
        ...(status === undefined ? {} : { httpStatus: status }), ...(rejected === undefined ? {} : { rejectedRecords: rejected }) });
      if (response.destroyed) return;
      if (outcome !== "accepted" && outcome !== "partial") return deny(response, 502, "export_unconfirmed");
      response.writeHead(200, { "content-type": contentType!, "cache-control": "no-store" });
      response.end(evalOtlpResponse(rejected!, contentType!, signal));
    })();
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => { poisoned = true; pending.delete(operation); deny(response, 503, "receipt_persistence_failed"); });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = limits.maxConcurrent + 8;
  try { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
  catch (error) { await file.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { await file.close(); throw new Error("Eval OTLP relay did not bind loopback"); }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    closed = true; clearTimeout(timer); controllers.forEach(controller => controller.abort()); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...pending]);
    try { await record({ type: "closed", at: new Date().toISOString(), ...usage, poisoned }); }
    finally { await file.close(); }
  })();
  const timer = setTimeout(() => { void close().catch(() => {}); }, Math.max(1, input.deadlineAt - Date.now())); timer.unref();
  return { baseUrl: `http://127.0.0.1:${address.port}/otel`, token, receiptPath: input.receiptPath, close };
}
