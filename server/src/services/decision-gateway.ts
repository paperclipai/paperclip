import {
  centsToUnits, decisionModelIdSchema, unitsToCents,
  type DecisionAnswer, type DecisionModelList, type DecisionModelOption, type DecisionRequest, type DecisionRoute,
} from "@paperclipai/shared";
import type { DecisionProviderOutcome, DecisionProviderReceipt } from "./decision-model-provider.js";

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_REPLY_BYTES = 1_000_000;
const MAX_MODEL_LIST_BYTES = 8_000_000;
const MAX_MODELS = 1000;
const MAX_OUTPUT_TOKENS = 2000;

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const tokenCount = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647 ? v : null;
const probability = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function gatewayHeaders(route: Pick<DecisionRoute, "auth" | "protocol">, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (route.auth === "bearer" && apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (route.auth === "api_key" && apiKey) headers["x-api-key"] = apiKey;
  if (route.protocol === "messages") headers["anthropic-version"] = "2023-06-01";
  return headers;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text) > limit) throw new Error("response_too_large");
  return JSON.parse(text);
}

function questionContract(request: DecisionRequest) {
  return Object.entries(request.questions).map(([id, question]) => {
    if (question.type === "boolean") return `"${id}": {"probability": <number from 0 to 1 that the answer is yes>}`;
    if (question.type === "choice") return `"${id}": {"choice": <exactly one of ${JSON.stringify(Object.keys(question.criteria))}>}`;
    return `"${id}": {"score": <integer index from 0 to ${question.criteria.length - 1} into the ordered criteria>}`;
  }).join(",\n");
}

export function gatewayDecisionPrompt(request: DecisionRequest) {
  const system = [
    "You are a decision function. Read the state and answer every question using only the given instructions and criteria.",
    "Reply with a single JSON object and nothing else: no prose, no markdown.",
    "The object must have exactly one key, \"answers\", whose value has exactly these keys:",
    "{\n" + questionContract(request) + "\n}",
    "Each answer may also include \"confidence\": a number from 0 to 1.",
  ].join("\n");
  const user = JSON.stringify({ state: request.state, questions: request.questions });
  return { system, user };
}

function unwrapJson(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

export function parseGatewayAnswers(request: DecisionRequest, text: string): Record<string, DecisionAnswer> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(unwrapJson(text)); } catch { return null; }
  const root = record(parsed);
  const answers = record(root.answers);
  const expected = Object.keys(request.questions);
  if (Object.keys(answers).length !== expected.length) return null;
  const result: Record<string, DecisionAnswer> = {};
  for (const id of expected) {
    const question = request.questions[id];
    const raw = record(answers[id]);
    const confidence = raw.confidence === undefined ? undefined : probability(raw.confidence) ? raw.confidence as number : null;
    if (confidence === null) return null;
    const extra = confidence === undefined ? {} : { confidence };
    if (question.type === "boolean") {
      if (!probability(raw.probability)) return null;
      result[id] = { type: "boolean", probability: raw.probability as number, ...extra };
    } else if (question.type === "choice") {
      if (typeof raw.choice !== "string" || !Object.hasOwn(question.criteria, raw.choice)) return null;
      result[id] = { type: "choice", choice: raw.choice, ...extra };
    } else {
      if (typeof raw.score !== "number" || !Number.isInteger(raw.score) || raw.score < 0 || raw.score >= question.criteria.length) return null;
      result[id] = { type: "score", score: raw.score, ...extra };
    }
  }
  return result;
}

export function gatewayReceipt(protocol: "chat" | "messages", body: unknown, requestId: string | null): DecisionProviderReceipt {
  const value = record(body), usage = record(value.usage);
  const inputTokens = tokenCount(protocol === "chat" ? usage.prompt_tokens : usage.input_tokens);
  const outputTokens = tokenCount(protocol === "chat" ? usage.completion_tokens : usage.output_tokens);
  const providerRequestId = typeof value.id === "string" ? value.id.slice(0, 250) : requestId?.slice(0, 250) ?? null;
  const cost = usage.cost;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    return { inputTokens, outputTokens, providerRequestId, costCents: unitsToCents(centsToUnits(cost * 100)), costStatus: "reported", pricingProvenance: { source: "provider_reported" } };
  }
  return { inputTokens, outputTokens, providerRequestId, costCents: null, costStatus: "unpriced", pricingProvenance: { source: "unknown" } };
}

function replyText(protocol: "chat" | "messages", body: unknown): string | null {
  const value = record(body);
  if (protocol === "chat") {
    const choices = Array.isArray(value.choices) ? value.choices : [];
    const content = record(record(choices[0]).message).content;
    return typeof content === "string" ? content : null;
  }
  const blocks = Array.isArray(value.content) ? value.content : [];
  const text = blocks.map(block => record(block)).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string).join("");
  return text || null;
}

function unpricedReceipt(): DecisionProviderReceipt {
  return { inputTokens: null, outputTokens: null, providerRequestId: null, costCents: null, costStatus: "unpriced", pricingProvenance: { source: "unknown" } };
}

function rejectedBeforeWork(status: number): DecisionProviderOutcome {
  const errorCode = status === 401 || status === 403 ? "provider_auth_failed" : status === 429 ? "provider_rate_limited" : "provider_failed";
  return { errorCode, noProviderWork: true, receipt: { inputTokens: 0, outputTokens: 0, providerRequestId: null, costCents: "0.0000000", costStatus: "estimated",
    pricingProvenance: { source: "unknown", evidence: `Provider rejected request before model work (HTTP ${status})` } } };
}

export async function runGatewayDecision(input: {
  route: DecisionRoute; model: string; apiKey: string; request: DecisionRequest; signal: AbortSignal;
}, options: { fetch?: typeof fetch } = {}): Promise<DecisionProviderOutcome> {
  const transport = options.fetch ?? fetch;
  const protocol = input.route.protocol === "messages" ? "messages" : "chat";
  const { system, user } = gatewayDecisionPrompt(input.request);
  const body = protocol === "chat"
    ? { model: input.model, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content: user }] }
    : { model: input.model, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, system, messages: [{ role: "user", content: user }] };
  let response: Response;
  try {
    response = await transport(`${input.route.baseUrl}/${protocol === "chat" ? "chat/completions" : "messages"}`, {
      method: "POST", signal: input.signal, body: JSON.stringify(body),
      headers: { ...gatewayHeaders(input.route, input.apiKey), "content-type": "application/json" },
    });
  } catch {
    return { errorCode: input.signal.aborted ? "timeout" : "provider_failed", receipt: unpricedReceipt() };
  }
  const requestId = response.headers.get("x-request-id");
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if ([400, 401, 403, 404, 422, 429].includes(response.status)) return rejectedBeforeWork(response.status);
    return { errorCode: "provider_failed", receipt: unpricedReceipt() };
  }
  let payload: unknown;
  try { payload = await boundedJson(response, MAX_REPLY_BYTES); }
  catch { return { errorCode: input.signal.aborted ? "timeout" : "invalid_response", receipt: unpricedReceipt() }; }
  const receipt = gatewayReceipt(protocol, payload, requestId);
  const text = replyText(protocol, payload);
  const answers = text ? parseGatewayAnswers(input.request, text) : null;
  return answers ? { answers, receipt } : { errorCode: "invalid_response", receipt };
}

function modelsUrl(route: DecisionRoute) {
  if (route.provider === "openrouter") return OPENROUTER_MODELS_URL;
  if (route.provider === "openai") return OPENAI_MODELS_URL;
  return `${route.baseUrl}/models`;
}

export function normalizeModelList(payload: unknown, configured: DecisionModelOption[] = []): DecisionModelOption[] {
  const rows = Array.isArray(record(payload).data) ? record(payload).data as unknown[] : Array.isArray(payload) ? payload : [];
  const seen = new Set<string>();
  const models: DecisionModelOption[] = [];
  for (const raw of [...configured, ...rows]) {
    const row = record(raw);
    const id = decisionModelIdSchema.safeParse(row.id);
    if (!id.success || seen.has(id.data)) continue;
    const label = [row.name, row.display_name, row.label].find(v => typeof v === "string" && v.trim()) as string | undefined;
    seen.add(id.data);
    models.push({ id: id.data, name: (label ?? id.data).trim().slice(0, 200) });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

export async function listDecisionModels(input: {
  route: DecisionRoute; apiKey: string; configured?: DecisionModelOption[]; signal?: AbortSignal;
}, options: { fetch?: typeof fetch } = {}): Promise<DecisionModelList> {
  const transport = options.fetch ?? fetch;
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const headers = input.route.provider === "openrouter" ? { accept: "application/json" } : gatewayHeaders(input.route, input.apiKey);
  let response: Response;
  try { response = await transport(modelsUrl(input.route), { method: "GET", headers, signal }); }
  catch { return { models: [], errorCode: signal.aborted ? "timeout" : "provider_failed" }; }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const errorCode = response.status === 401 || response.status === 403 ? "provider_auth_failed" : response.status === 429 ? "provider_rate_limited" : "provider_failed";
    return { models: [], errorCode };
  }
  try { return { models: normalizeModelList(await boundedJson(response, MAX_MODEL_LIST_BYTES), input.configured ?? []) }; }
  catch { return { models: [], errorCode: signal.aborted ? "timeout" : "invalid_response" }; }
}
