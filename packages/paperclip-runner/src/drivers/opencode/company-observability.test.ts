import { expect, it, vi } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { createOpenCodeCompanyObservability } from "./company-observability.js";

const environment = {
  PAPERCLIP_OBSERVABILITY_OPENCODE: "1", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20secret-canary",
  OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,private.extra=must-not-export",
  OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_ASSISTANT_RESPONSES: "1", OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_TOOL_CONTENT: "1",
};
const event = (eventType: PrpEvent["eventType"], payload: Record<string, unknown> = {}, runId = "run-one", itemId?: string): PrpEvent => ({
  schema: "paperclip.prp.event.v1", sourceEventId: "event", sourceSeq: 1, sourceInstanceId: "runner", sourceKind: "runner",
  runId, normalizedSessionId: "session", turnId: `turn-${runId}`, ...(itemId ? { itemId } : {}), eventType, schemaVersion: 1,
  priority: 1, emittedAt: new Date().toISOString(), payload,
});
const spanAttributes = (span: { attributes: { key: string; value: { stringValue?: string; doubleValue?: number; boolValue?: boolean } }[] }) =>
  Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue ?? a.value.doubleValue ?? a.value.boolValue]));
function setup(env = environment, response = new Response("{}")) {
  const bodies: any[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response; });
  const diagnostic = vi.fn();
  const observer = createOpenCodeCompanyObservability({ environment: env, model: "openrouter/test-model", sensitiveValues: ["provider-secret"], fetch: transport, onDiagnostic: diagnostic });
  return { observer: observer!, bodies, transport, diagnostic };
}
it("requires an explicit controller opt-in even when ambient OTLP is configured", () => {
  expect(setup({ ...environment, PAPERCLIP_OBSERVABILITY_OPENCODE: "0" }).observer).toBeUndefined();
  expect(createOpenCodeCompanyObservability({ environment: undefined, model: "test", sensitiveValues: [] })).toBeUndefined();
});
it("exports turn and tool content without raw payloads, reasoning, credentials or duplicate usage", async () => {
  const { observer, bodies, transport } = setup();
  observer.observe(event("turn.submitted", { text: "question secret-canary provider-secret", raw: "private" }));
  observer.observe(event("item.completed", { kind: "reasoning", text: "HIDDEN REASONING" }));
  observer.observe(event("tool.execution.started", { name: "read" }, "run-one", "tool-one"));
  observer.observe(event("tool.execution.completed", { name: "read", output: "answer secret-canary", status: "failed", raw: "private" }, "run-one", "tool-one"));
  observer.observe(event("item.completed", { kind: "usage", usageMessageId: "message", usage: { input: 10, output: 2, costUsd: 0.1 } }));
  observer.observe(event("item.completed", { kind: "usage", usageMessageId: "message", usage: { input: 12, output: 3, cache: { read: 4 }, costUsd: 0.2 } }));
  observer.observe(event("item.completed", { kind: "agentMessage", text: "final answer" }));
  observer.observe(event("turn.completed"));
  await observer.close();
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer secret-canary" } });
  const wire = JSON.stringify(bodies);
  for (const excluded of ["secret-canary", "provider-secret", "private", "HIDDEN REASONING"]) expect(wire).not.toContain(excluded);
  const spans = bodies[0].resourceSpans[0].scopeSpans[0].spans;
  expect(spans).toHaveLength(3);
  expect(spanAttributes(spans[0])).toMatchObject({ "braintrust.input": "question [REDACTED] [REDACTED]", "braintrust.output": "final answer", "paperclip.run.id": "run-one", "paperclip.company.id": "company" });
  expect(spans[1].status.code).toBe(2);
  expect(spanAttributes(spans[2])).toMatchObject({ "gen_ai.usage.input_tokens": 12, "gen_ai.usage.cache_read.input_tokens": 4, "paperclip.cost.usd": 0.2 });
});
it("honors all capture switches while retaining usage and the correct warm-run identity", async () => {
  const { observer, bodies } = setup({ ...environment, OTEL_LOG_USER_PROMPTS: "0", OTEL_LOG_ASSISTANT_RESPONSES: "0", OTEL_LOG_TOOL_CONTENT: "0" });
  for (const runId of ["first", "second"]) {
    observer.observe(event("turn.submitted", { text: "private-prompt" }, runId));
    observer.observe(event("tool.execution.completed", { name: "read", output: "private-tool" }, runId, "tool"));
    observer.observe(event("item.completed", { kind: "agentMessage", text: "private-response" }, runId));
    observer.observe(event("item.completed", { kind: "usage", usageMessageId: "reused", usage: { input: 3, costUsd: null } }, runId));
    observer.observe(event("turn.completed", {}, runId));
  }
  await observer.close();
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies)).not.toContain("private-");
  const spans = bodies.map(b => b.resourceSpans[0].scopeSpans[0].spans);
  expect(spanAttributes(spans[0][0])["paperclip.run.id"]).toBe("first");
  expect(spanAttributes(spans[1][0])["paperclip.run.id"]).toBe("second");
  expect(spans[0][0].traceId).not.toBe(spans[1][0].traceId);
  expect(spanAttributes(spans[1][2])).not.toHaveProperty("paperclip.cost.usd");
});
it.each([new Response('{"partialSuccess":{"rejectedSpans":"1"}}'), new Response("secret-canary", { status: 403 }), new Response("[]")])(
  "reports export failure without exposing response bodies or disrupting close", async response => {
    const { observer, diagnostic } = setup(environment, response);
    observer.observe(event("turn.submitted")); observer.observe(event("turn.failed"));
    await expect(observer.close()).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith("Company observability export unavailable (export_failed).");
  },
);
it("bounds rows and content and marks an interrupted active turn on close", async () => {
  const { observer, bodies } = setup();
  observer.observe(event("turn.submitted", { text: "x".repeat(100000) }));
  for (let i = 0; i < 100; i++) observer.observe(event("tool.execution.completed", { name: "read", output: "x".repeat(100000) }, "run-one", String(i)));
  await observer.close();
  const spans = bodies[0].resourceSpans[0].scopeSpans[0].spans;
  expect(spans).toHaveLength(65);
  expect(spans[0].status.code).toBe(2);
  expect(spanAttributes(spans[0])["paperclip.observability.truncated"]).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(bodies[0]))).toBeLessThan(1048576);
});
it.each(["prompt", "answer", "tool", "upstream-tool"])("marks a shortened %s even below the span limit", async kind => {
  const { observer, bodies } = setup();
  const longText = "😀".repeat(3000);
  observer.observe(event("turn.submitted", { text: kind === "prompt" ? longText : "short" }));
  if (kind === "answer") observer.observe(event("item.completed", { kind: "agentMessage", text: longText }));
  if (kind === "tool" || kind === "upstream-tool") observer.observe(event("tool.execution.completed", {
    name: "read", output: kind === "tool" ? longText : "excerpt", outputTruncated: kind === "upstream-tool",
  }, "run-one", "tool"));
  observer.observe(event("turn.completed"));
  await observer.close();
  const spans = bodies[0].resourceSpans[0].scopeSpans[0].spans;
  expect(spanAttributes(spans[0])["paperclip.observability.truncated"]).toBe(true);
  for (const span of spans) for (const [key, value] of Object.entries(spanAttributes(span))) {
    if (key.startsWith("braintrust.") && typeof value === "string") {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(8192);
      expect(value).not.toContain("\uFFFD");
    }
  }
});
it("does not block event delivery when a receiver stalls and cancels the request at its deadline", async () => {
  const diagnostics: string[] = [];
  let aborted = false;
  const transport: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private receiver failure")); }, { once: true });
  });
  const observer = createOpenCodeCompanyObservability({ environment, model: "test", sensitiveValues: [], fetch: transport, onDiagnostic: text => diagnostics.push(text) })!;
  const start = performance.now();
  observer.observe(event("turn.submitted")); observer.observe(event("turn.completed"));
  expect(performance.now() - start).toBeLessThan(100);
  await observer.close();
  expect(aborted).toBe(true);
  expect(diagnostics).toEqual(["Company observability export unavailable (export_failed)."]);
}, 5000);

it("bounds dispatch diagnostics without traversing arbitrary keys or nested values", async () => {
  const { observer, bodies } = setup();
  observer.observe(event("turn.submitted"));
  const args = { name: "provider-secret", arguments: { secret: "x".repeat(100000) }, ["private-key".repeat(10000)]: true };
  observer.observe(event("item.started", { kind: "dynamicToolCall", item: { name: "paperclip_call_assigned_tool", arguments: args } }, "run-one", "call"));
  observer.observe(event("item.completed", { kind: "dynamicToolCall", item: { result: { message: "provider-secret secret-canary" } } }, "run-one", "call"));
  observer.observe(event("turn.completed"));
  await observer.close();
  const spans = bodies[0].resourceSpans[0].scopeSpans[0].spans;
  const attributes = spanAttributes(spans[1]);
  expect(JSON.parse(String(attributes["braintrust.input"]))).toEqual({ schema: "paperclip.opencode.tool-diagnostics.v1", method: "tools/call", argumentType: "object", fields: { name: "string", arguments: "object" } });
  expect(attributes["braintrust.output"]).toBe('{"message":"[REDACTED] [REDACTED]"}');
  expect(Buffer.byteLength(String(attributes["braintrust.input"]))).toBeLessThan(1024);
  expect(JSON.stringify(bodies)).not.toContain("private-key");
});
it.each([null, [], "private-string"])("exports only the type for non-object arguments %j", async args => {
  const { observer, bodies } = setup();
  observer.observe(event("turn.submitted"));
  observer.observe(event("item.started", { kind: "dynamicToolCall", item: { name: "tool", arguments: args } }, "run-one", "call"));
  observer.observe(event("turn.completed"));
  await observer.close();
  const spans = bodies[0].resourceSpans[0].scopeSpans[0].spans;
  expect(JSON.parse(String(spanAttributes(spans[1])["braintrust.input"])).fields).toEqual({});
  expect(JSON.stringify(bodies)).not.toContain("private-string");
});
it("does not export dispatch spans when tool details are disabled", async () => {
  const { observer, bodies } = setup({ ...environment, OTEL_LOG_TOOL_DETAILS: "0" });
  observer.observe(event("turn.submitted"));
  observer.observe(event("item.started", { kind: "dynamicToolCall", item: { name: "tool", arguments: { name: "private-name" } } }, "run-one", "call"));
  observer.observe(event("turn.completed"));
  await observer.close();
  expect(bodies[0].resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  expect(JSON.stringify(bodies)).not.toContain("private-name");
});

it("retains provider failures for declared tools even before any dispatch", async () => {
  const bodies: any[] = [];
  const observer = createOpenCodeCompanyObservability({ environment, model: "test", sensitiveValues: [], managedToolNames: ["paperclip_call_assigned_tool"],
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response("{}"); } })!;
  observer.observe(event("turn.submitted"));
  observer.observe(event("tool.execution.completed", { name: "paperclip_call_assigned_tool", status: "failed", output: "request exceeded limit" }, "run-one", "native-rejection"));
  observer.observe(event("turn.completed"));
  await observer.close();
  const spans = bodies[0].resourceSpans[0].scopeSpans[0].spans;
  expect(spans[1].name).toBe("opencode tool paperclip_call_assigned_tool");
  expect(spans[1].status.code).toBe(2);
  expect(spanAttributes(spans[1])).toMatchObject({ "paperclip.tool.source": "provider", "braintrust.output": "request exceeded limit" });
});
