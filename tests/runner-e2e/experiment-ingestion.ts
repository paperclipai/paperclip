import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { isEvalProjectId } from "./eval-otlp-payload.js";

export const EVAL_EXPERIMENT_LIMITS = { maxRequests: 3, maxTotalBytes: 4 * 1024 * 1024, maxScores: 14 } as const;

export async function openExperimentIngestion(input: {
  receiptPath: string; campaignId: string; projectId: string; deadlineAt: number; transport?: typeof fetch;
}) {
  if (!path.isAbsolute(input.receiptPath) || !/^[A-Za-z0-9_.:-]{1,512}$/.test(input.campaignId)
      || !isEvalProjectId(input.projectId) || !Number.isFinite(input.deadlineAt)
      || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 60_000) throw new Error("Invalid experiment ingestion policy");
  await mkdir(path.dirname(input.receiptPath), { recursive: true, mode: 0o700 });
  const file = await open(input.receiptPath, "ax", 0o600);
  let writes = Promise.resolve(), closed = false, poisoned = false, active = false;
  let admittedRequests = 0, admittedBytes = 0, admittedScores = 0, responses = 0;
  const record = (value: object) => {
    writes = writes.then(async () => { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); })
      .catch(error => { poisoned = true; throw error; });
    return writes;
  };
  try { await record({ type: "policy", version: 1, kind: "experiment", projectId: input.projectId, campaignId: input.campaignId,
    limits: EVAL_EXPERIMENT_LIMITS, openedAt: new Date().toISOString(), deadlineAt: new Date(input.deadlineAt).toISOString() }); }
  catch (error) { await file.close(); throw error; }
  const transport: typeof fetch = async (target, init) => {
    if (closed || poisoned || active || Date.now() >= input.deadlineAt) throw new Error("Experiment ingestion unavailable");
    const url = String(target), method = init?.method;
    const create = url === "https://api.braintrust.dev/v1/experiment" && method === "POST";
    const insert = /^https:\/\/api\.braintrust\.dev\/v1\/experiment\/[0-9a-f-]{36}\/insert$/.test(url) && method === "POST";
    const summarize = /^https:\/\/api\.braintrust\.dev\/v1\/experiment\/[0-9a-f-]{36}\/summarize$/.test(url) && method === "GET";
    if (!create && !insert && !summarize || summarize && init?.body !== undefined
        || !summarize && typeof init?.body !== "string") throw new Error("Unqualified experiment ingestion request");
    const body = summarize ? "" : init!.body as string;
    const bytes = Buffer.byteLength(body);
    if (bytes > EVAL_EXPERIMENT_LIMITS.maxTotalBytes) throw new Error("Experiment ingestion byte limit");
    let scores = 0;
    if (body) {
      const payload = JSON.parse(body);
      if (create && payload.project_id !== input.projectId) throw new Error("Experiment ingestion project mismatch");
      if (insert) {
        if (!Array.isArray(payload.events)) throw new Error("Invalid experiment ingestion events");
        scores = payload.events.reduce((sum: number, event: { scores?: object }) => sum + Object.keys(event.scores ?? {}).length, 0);
      }
    }
    if (admittedRequests >= EVAL_EXPERIMENT_LIMITS.maxRequests || admittedBytes + bytes > EVAL_EXPERIMENT_LIMITS.maxTotalBytes
        || admittedScores + scores > EVAL_EXPERIMENT_LIMITS.maxScores) throw new Error("Experiment ingestion allowance exhausted");
    active = true;
    const id = randomUUID();
    admittedRequests++; admittedBytes += bytes; admittedScores += scores;
    try {
      await record({ type: "admitted", id, at: new Date().toISOString(), operation: create ? "create" : insert ? "insert" : "summarize",
        bodyBytes: bytes, scores, payloadSha256: createHash("sha256").update(body).digest("hex") });
      if (closed || poisoned || Date.now() >= input.deadlineAt) throw new Error("Experiment ingestion unavailable");
      let response: Response;
      try {
        const upstream = await (input.transport ?? fetch)(target, { ...init, redirect: "error", signal: AbortSignal.any([
          AbortSignal.timeout(Math.max(1, Math.min(15_000, input.deadlineAt - Date.now()))), ...(init?.signal ? [init.signal] : []),
        ]) });
        const reader = upstream.body?.getReader(), chunks: Uint8Array[] = [];
        let responseBytes = 0;
        try {
          while (reader) {
            const next = await reader.read();
            if (next.done) break;
            responseBytes += next.value.length;
            if (responseBytes > 1_048_576) throw new Error("Oversized experiment response");
            chunks.push(next.value);
          }
          response = new Response(upstream.body === null ? null : Buffer.concat(chunks), { status: upstream.status, headers: upstream.headers });
        } finally { await reader?.cancel().catch(() => {}); }
      } catch {
        await record({ type: "outcome", id, at: new Date().toISOString(), outcome: "unconfirmed" });
        throw new Error("Experiment ingestion response unconfirmed");
      }
      try { await record({ type: "outcome", id, at: new Date().toISOString(), outcome: "response", httpStatus: response.status }); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      responses++;
      return response;
    } finally { active = false; }
  };
  let closing: Promise<void> | undefined;
  return { transport, close: () => closing ??= (async () => {
    closed = true;
    try {
      if (active) throw new Error("Experiment ingestion is still in flight");
      await record({ type: "closed", at: new Date().toISOString(), admittedRequests, admittedBytes, admittedScores,
        responses, unresolvedRequests: admittedRequests - responses });
    } finally { await file.close(); }
  })() };
}
