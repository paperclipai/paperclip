import { describe, expect, it, vi } from "vitest";
import { DECISION_MODELS, DECISION_TEST_REQUEST, decisionProviderForConnection, decisionRouteForConnection, type DecisionRoute } from "@paperclipai/shared";
import { decisionReceipt, runDecisionProvider } from "../services/decision-model-provider.js";
import { listDecisionModels, parseGatewayAnswers } from "../services/decision-gateway.js";

function openaiResponse() {
  return { model: "gpt-6-luna", usage: { input_tokens: 123, output_tokens: 0 }, answers: [
    { type: "predicate", name: "billing", probability: 0.99 },
    { type: "choice", name: "team", choice: "billing", confidence: 0.9, probabilities: [{ value: "billing", probability: 0.9 }, { value: "technical", probability: 0.1 }] },
    { type: "score", name: "severity", score: 0.1, probabilities: [{ value: 0, probability: 0.9 }, { value: 1, probability: 0.1 }, { value: 2, probability: 0 }] },
  ] };
}
function openrouterResponse() {
  return { id: "decision-fixture", model: "typesafe/jev-1.13", usage: { input_tokens: 123, output_tokens: 0, cost: 0.000005166 }, answers: {
    billing: { type: "noul", noul: 0.99 }, team: { type: "choice", choice: "billing", confidence: 0.85, probabilities: { billing: 0.9, technical: 0.1 } },
    severity: { type: "score", score: 0.1, probabilities: { "0": 0.9, "1": 0.1, "2": 0 } },
  } };
}
describe("decision provider contract", () => {
  it.each(["openai", "openrouter"] as const)("uses native %s decisions with the selected credential and preserves answers and fractional costs", async provider => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(provider === "openai" ? openaiResponse() : openrouterResponse()));
    const result = await runDecisionProvider({ provider, model: DECISION_MODELS[provider].id, apiKey: "selected-credential", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe(provider === "openai" ? "https://api.openai.com/v1/decisions" : "https://openrouter.ai/api/alpha/decisions");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer selected-credential");
    expect(new Headers(options?.headers).get("http-referer")).toBe(provider === "openrouter" ? "https://paperclip.ing" : null);
    expect(new Headers(options?.headers).get("x-openrouter-title")).toBe(provider === "openrouter" ? "Paperclip" : null);
    expect(result.answers).toMatchObject({ billing: { type: "boolean", probability: 0.99 }, team: { type: "choice", choice: "billing", confidence: provider === "openai" ? 0.9 : 0.85 }, severity: { type: "score", score: 0.1 } });
    expect(result.receipt.costCents).toBe(provider === "openai" ? "0.0012300" : "0.0005166");
    expect(JSON.stringify(result.receipt)).not.toContain("customer");
    expect(JSON.parse(String(options?.body)).model).toBe(DECISION_MODELS[provider].id);
  });
  it("keeps usage for a charged refusal and never treats it as an answer", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...openaiResponse(), answers: [{ type: "refusal", name: null }] }));
    const result = await runDecisionProvider({ provider: "openai", model: "gpt-6-luna", apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(result.answers).toBeUndefined(); expect(result.errorCode).toBe("refused"); expect(result.receipt.inputTokens).toBe(123);
  });
  it.each([401, 429, 500])("does not retry HTTP %i or retain its response body", async status => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "PRIVATE STATE AND KEY", type: "server_error" } }, { status }));
    const result = await runDecisionProvider({ provider: "openai", model: "gpt-6-luna", apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1); expect(result.receipt.costStatus).toBe(status === 500 ? "unpriced" : "estimated"); expect(result.noProviderWork).toBe(status !== 500); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("preserves usage when answer validation fails", async () => {
    const response = openrouterResponse(); response.answers.team.choice = "invented";
    const result = await runDecisionProvider({ provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: async () => Response.json(response) });
    expect(result.answers).toBeUndefined(); expect(result.receipt.costStatus).toBe("reported");
  });
  it.each(["openai", "openrouter"] as const)("retains the %s receipt when the SDK rejects malformed wire answers", async provider => {
    const wire = provider === "openai" ? { ...openaiResponse(), answers: [{ type: "predicate", name: "billing", probability: 2 }] }
      : { ...openrouterResponse(), answers: { billing: { type: "noul", noul: "not-a-probability" } } };
    const result = await runDecisionProvider({ provider, model: DECISION_MODELS[provider].id, apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: async () => Response.json(wire) });
    expect(result.answers).toBeUndefined(); expect(result.receipt.inputTokens).toBe(123);
    expect(result.receipt.costStatus).toBe(provider === "openai" ? "estimated" : "reported");
  });
  it("fails closed on an OpenRouter refusal while retaining any reported charge", async () => {
    const result = await runDecisionProvider({ provider: "openrouter", model: DECISION_MODELS.openrouter.id, apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal },
      { fetch: async () => Response.json({ ...openrouterResponse(), answers: { billing: { type: "refusal" } } }) });
    expect(result.answers).toBeUndefined(); expect(result.errorCode).toBe("refused"); expect(result.receipt.costStatus).toBe("reported");
  });
  it("does not invent prices when usage or a supported rate is missing", () => {
    expect(decisionReceipt("openai", {}).costCents).toBeNull();
    expect(decisionReceipt("openai", { usage: { inputTokens: 100_000 } }).costStatus).toBe("unpriced");
    expect(decisionReceipt("openrouter", { usage: { inputTokens: 1 } }).costCents).toBeNull();
    expect(decisionReceipt("openrouter", { providerMetadata: { openrouter: { usage: { cost: 0 } } } }).costStatus).toBe("reported");
  });
  it("rejects subscription, personal endpoint routing and other provider capabilities", () => {
    expect(decisionProviderForConnection({ provider: "openai", method: "subscription" })).toBeNull();
    expect(decisionProviderForConnection({ provider: "openai", method: "api_key", routing: { kind: "gateway", baseUrl: "https://example.com" } })).toBeNull();
    expect(decisionProviderForConnection({ provider: "anthropic", method: "api_key" })).toBeNull();
    expect(decisionProviderForConnection({ provider: "openrouter", method: "api_key", routing: { kind: "openrouter" } })).toBe("openrouter");
  });
  it("passes a selected model to the native endpoint", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...openrouterResponse(), model: "other/model-2" }));
    await runDecisionProvider({ provider: "openrouter", model: "other/model-2", apiKey: "key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).model).toBe("other/model-2");
  });
});

const chatRoute: DecisionRoute = { provider: "gateway", protocol: "chat", baseUrl: "https://gateway.example/v1", auth: "bearer", defaultModel: null };
const messagesRoute: DecisionRoute = { ...chatRoute, protocol: "messages" };
const validReply = JSON.stringify({ answers: { billing: { probability: 0.97 }, team: { choice: "billing", confidence: 0.8 }, severity: { score: 0 } } });
function chatBody(content: string, usage: Record<string, unknown> = { prompt_tokens: 210, completion_tokens: 30 }) {
  return { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content } }], usage };
}
describe("gateway decision fallback", () => {
  it("accepts gateway API-key connections for chat and messages and keeps subscriptions out", () => {
    const routing = { kind: "gateway", baseUrl: "https://gateway.example/v1/", auth: "bearer", models: [] };
    expect(decisionRouteForConnection({ provider: "openai", method: "api_key", routing: { ...routing, protocol: "chat" } })).toMatchObject({ provider: "gateway", protocol: "chat", baseUrl: "https://gateway.example/v1", defaultModel: null });
    expect(decisionRouteForConnection({ provider: "anthropic", method: "api_key", routing: { ...routing, protocol: "messages", models: [{ id: "m-1" }] } })).toMatchObject({ protocol: "messages", defaultModel: "m-1" });
    expect(decisionRouteForConnection({ provider: "openai", method: "subscription", routing: { ...routing, protocol: "chat" } })).toBeNull();
    expect(decisionRouteForConnection({ provider: "anthropic", method: "subscription" })).toBeNull();
    expect(decisionRouteForConnection({ provider: "openai", method: "api_key", routing: { ...routing, protocol: "responses" } })).toBeNull();
    expect(decisionRouteForConnection({ provider: "openai", method: "api_key", routing: { ...routing, kind: "local", protocol: "chat" } })).toBeNull();
    expect(decisionRouteForConnection({ provider: "openrouter", method: "api_key" })).toMatchObject({ provider: "openrouter", protocol: "decisions", defaultModel: DECISION_MODELS.openrouter.id });
  });
  it("sends one chat request with the selected model and validates the JSON answer", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(chatBody("```json\n" + validReply + "\n```")));
    const result = await runDecisionProvider({ provider: "gateway", route: chatRoute, model: "combo/fast", apiKey: "gateway-key", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe("https://gateway.example/v1/chat/completions");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer gateway-key");
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe("combo/fast");
    expect(body.messages[1].content).toContain("charged twice");
    expect(result.answers).toEqual({ billing: { type: "boolean", probability: 0.97 }, team: { type: "choice", choice: "billing", confidence: 0.8 }, severity: { type: "score", score: 0 } });
    expect(result.receipt).toMatchObject({ inputTokens: 210, outputTokens: 30, costStatus: "unpriced", costCents: null, providerRequestId: "chatcmpl-1" });
    expect(JSON.stringify(result.receipt)).not.toContain("charged");
  });
  it("uses the messages protocol and keeps a reported cost", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "msg_1", content: [{ type: "text", text: validReply }], usage: { input_tokens: 50, output_tokens: 9, cost: 0.0001 } }));
    const result = await runDecisionProvider({ provider: "gateway", route: messagesRoute, model: "claude-x", apiKey: "k", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    const [url, options] = transport.mock.calls[0];
    expect(String(url)).toBe("https://gateway.example/v1/messages");
    expect(new Headers(options?.headers).get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(String(options?.body)).system).toContain("\"answers\"");
    expect(result.answers?.team).toMatchObject({ choice: "billing" });
    expect(result.receipt).toMatchObject({ inputTokens: 50, outputTokens: 9, costStatus: "reported", costCents: "0.0100000" });
  });
  it.each([
    ["prose", "The answer is billing."],
    ["an unknown choice", JSON.stringify({ answers: { billing: { probability: 0.5 }, team: { choice: "sales" }, severity: { score: 1 } } })],
    ["a probability out of range", JSON.stringify({ answers: { billing: { probability: 1.5 }, team: { choice: "billing" }, severity: { score: 1 } } })],
    ["a fractional score", JSON.stringify({ answers: { billing: { probability: 0.5 }, team: { choice: "billing" }, severity: { score: 0.5 } } })],
    ["a score past the criteria", JSON.stringify({ answers: { billing: { probability: 0.5 }, team: { choice: "billing" }, severity: { score: 3 } } })],
    ["a missing answer", JSON.stringify({ answers: { billing: { probability: 0.5 }, team: { choice: "billing" } } })],
    ["an extra answer", JSON.stringify({ answers: { billing: { probability: 0.5 }, team: { choice: "billing" }, severity: { score: 1 }, extra: { score: 1 } } })],
  ])("fails with invalid_response for %s and never invents an answer", async (_label, content) => {
    const result = await runDecisionProvider({ provider: "gateway", route: chatRoute, model: "m", apiKey: "k", request: DECISION_TEST_REQUEST, signal: new AbortController().signal },
      { fetch: async () => Response.json(chatBody(content)) });
    expect(result.answers).toBeUndefined(); expect(result.errorCode).toBe("invalid_response"); expect(result.receipt.inputTokens).toBe(210);
    expect(JSON.stringify(result)).not.toContain("billing.");
  });
  it.each([401, 429, 500])("does not retry gateway HTTP %i or keep its body", async status => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "PRIVATE STATE" } }, { status }));
    const result = await runDecisionProvider({ provider: "gateway", route: chatRoute, model: "m", apiKey: "k", request: DECISION_TEST_REQUEST, signal: new AbortController().signal }, { fetch: transport });
    expect(transport).toHaveBeenCalledTimes(1); expect(Boolean(result.noProviderWork)).toBe(status !== 500);
    expect(result.errorCode).toBe(status === 401 ? "provider_auth_failed" : status === 429 ? "provider_rate_limited" : "provider_failed");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("reports a timeout when the signal aborts", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await runDecisionProvider({ provider: "gateway", route: chatRoute, model: "m", apiKey: "k", request: DECISION_TEST_REQUEST, signal: controller.signal },
      { fetch: async (_url, init) => { init?.signal?.throwIfAborted(); return Response.json({}); } });
    expect(result).toMatchObject({ errorCode: "timeout", receipt: { costStatus: "unpriced" } });
  });
  it("rejects answers for a different question set", () => {
    expect(parseGatewayAnswers(DECISION_TEST_REQUEST, JSON.stringify({ billing: { probability: 1 } }))).toBeNull();
  });
});

describe("decision model listing", () => {
  it("lists OpenRouter models without a credential", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "typesafe/jev-1.13", name: "Jev" }, { id: "bad id" }, { id: "typesafe/jev-1.13" }] }));
    const result = await listDecisionModels({ route: { provider: "openrouter", protocol: "decisions", baseUrl: null, auth: "bearer", defaultModel: null }, apiKey: "" }, { fetch: transport });
    expect(String(transport.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/models");
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
    expect(result).toEqual({ models: [{ id: "typesafe/jev-1.13", name: "Jev" }] });
  });
  it("lists native OpenAI and gateway models with the bearer key", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "gpt-6-luna" }, { id: "claude-y", display_name: "Claude Y" }] }));
    expect(await listDecisionModels({ route: { provider: "openai", protocol: "decisions", baseUrl: null, auth: "bearer", defaultModel: null }, apiKey: "k1" }, { fetch: transport }))
      .toEqual({ models: [{ id: "gpt-6-luna", name: "gpt-6-luna" }, { id: "claude-y", name: "Claude Y" }] });
    expect(String(transport.mock.calls[0][0])).toBe("https://api.openai.com/v1/models");
    await listDecisionModels({ route: chatRoute, apiKey: "k2", configured: [{ id: "pinned", name: "Pinned" }] }, { fetch: transport });
    expect(String(transport.mock.calls[1][0])).toBe("https://gateway.example/v1/models");
    expect(new Headers(transport.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer k2");
  });
  it.each([
    [401, "provider_auth_failed"], [429, "provider_rate_limited"], [502, "provider_failed"],
  ])("returns an empty list for HTTP %i", async (status, errorCode) => {
    expect(await listDecisionModels({ route: chatRoute, apiKey: "k" }, { fetch: async () => new Response("PRIVATE", { status }) })).toEqual({ models: [], errorCode });
  });
  it("returns an empty list for invalid or oversized bodies", async () => {
    expect(await listDecisionModels({ route: chatRoute, apiKey: "k" }, { fetch: async () => new Response("not json") })).toEqual({ models: [], errorCode: "invalid_response" });
    expect(await listDecisionModels({ route: chatRoute, apiKey: "k" }, { fetch: async () => new Response("[]", { headers: { "content-length": "90000000" } }) })).toEqual({ models: [], errorCode: "invalid_response" });
  });
});
