import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

const enabled = process.env.PAPERCLIP_OPENCODE_QUALIFY === "1";
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("receiver did not bind");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
it.skipIf(!enabled).each([true, false])("exports the current request through installed OpenCode with prompt capture %s", async capture => {
  const root = await mkdtemp(join(tmpdir(), "opencode-observability-real-"));
  const modelRequests: string[] = [];
  const exports: any[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    modelRequests.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "observability-runtime-answer" }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "qualification", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    exports.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.end("{}");
  });
  let session: Awaited<ReturnType<OpenCodeServerDriver["openSession"]>> | undefined;
  try {
    const modelUrl = await listen(model), receiverUrl = await listen(receiver);
    const driver = new OpenCodeServerDriver({
      command: process.env.PAPERCLIP_TEST_OPENCODE_BINARY ?? "opencode", model: "paperclip/qualification",
      runtimeDirectory: root, conversationMode: "prepared", permissionMode: "deny",
      environment: { PATH: process.env.PATH, PAPERCLIP_AI_PROVIDER_URL: `${modelUrl}/v1`, PAPERCLIP_AI_PROVIDER_KEY: "local-fixture-only",
        PAPERCLIP_OBSERVABILITY_OPENCODE: "1", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${receiverUrl}/v1/traces`,
        OTEL_LOG_USER_PROMPTS: capture ? "1" : "0", OTEL_LOG_ASSISTANT_RESPONSES: "1",
        OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=disposable-company" },
    });
    session = await driver.openSession({ runId: "disposable-run", normalizedSessionId: "disposable-session", workingDirectory: root });
    const history = ["## Fresh session handoff", "History guidance.", JSON.stringify({ schema: "paperclip.native-session-handoff.v1", entries: [{ body: "old history ".repeat(1800) }] })].join("\n");
    const text = JSON.stringify({ schema: "paperclip.native-model-envelope.v3", task: { identifier: "TEST-1", title: "Current task", prompt: `${history}\n\ncurrent-runtime-request-canary` } });
    await session.startTurn({ message: { role: "user", text } });
    const events = [];
    for await (const event of session.events()) {
      events.push(event);
      if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) break;
    }
    expect(events.at(-1)?.eventType).toBe("turn.completed");
    await session.close({ reason: "test" });
    session = undefined;
    expect(modelRequests.some(body => body.includes("current-runtime-request-canary") && body.includes("old history"))).toBe(true);
    expect(events.find(event => event.eventType === "turn.submitted")?.payload.text).toBe(text);
    expect(exports).toHaveLength(1);
    const attrs = Object.fromEntries(exports[0].resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.boolValue]));
    expect(attrs["braintrust.output"]).toBe("observability-runtime-answer");
    if (capture) {
      expect(attrs["braintrust.input"]).toContain("current-runtime-request-canary");
      expect(attrs["braintrust.input"]).not.toContain("old history");
      expect(attrs["paperclip.observability.input.events"]).toBe("/api/heartbeat-runs/disposable-run/events");
    } else {
      expect(attrs).not.toHaveProperty("braintrust.input");
      expect(attrs).not.toHaveProperty("paperclip.observability.input.events");
      expect(JSON.stringify(exports)).not.toContain("current-runtime-request-canary");
    }
  } finally {
    await session?.close({ reason: "test" });
    await Promise.all([close(model), close(receiver)]);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
