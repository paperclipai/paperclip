import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "vitest";
import { requestHumanInputAction } from "../../protocol-actions/request-human-input.js";
import { resolvePinnedOpenCodeCommand } from "./opencode-server-driver.js";
import { startOpenCodeMcpBridge } from "./mcp-bridge.js";

type Row = Record<string, any>;
it("lets the pinned client correct a rejected question from schema-derived feedback without API fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-question-schema-"));
  const requests: Row[] = [], calls: unknown[] = [];
  const input = { idempotencyKey: "choice-1", interactionKind: "questions", title: "Choose a time", prompt: "Morning or Afternoon?",
    resolverPolicy: "human_only", continuationPolicy: "wake_assignee", payload: { version: 1,
      questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "time", prompt: "Morning or Afternoon?", required: true,
        answerMode: "single_select", options: [{ id: "am", label: "Morning" }, { id: "pm", label: "Afternoon" }] }] } } };
  let rawOutput = "", child: ChildProcess | undefined, exited: Promise<unknown> | undefined;
  const bridge = await startOpenCodeMcpBridge({ tools: [{ name: "request_human_input",
    description: requestHumanInputAction.live.descriptor.description, inputSchema: requestHumanInputAction.live.descriptor.inputSchema }],
    handler: async call => { calls.push(call.arguments); return { disposition: "applied", interaction: { id: "card", ...call.arguments as object } }; } });
  const provider = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || "{}"); requests.push({ url: request.url, body });
    if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const question = body.tools?.find((tool: Row) => tool.function?.name === "paperclip_request_human_input");
    const feedback = body.messages?.filter((message: Row) => message.role === "tool").at(-1)?.content;
    const corrected = typeof feedback === "string" && feedback.includes("questionSet") && feedback.includes("expected 1");
    const complete = calls.length > 0 || requests.length >= 3;
    const delta = complete ? { role: "assistant", content: "Question fixture done." }
      : { role: "assistant", tool_calls: [{ index: 0, id: "question-call", type: "function", function: {
        name: question?.function.name ?? "paperclip_request_human_input",
        arguments: JSON.stringify(corrected ? input : { ...input, payload: { version: 2 } }),
      } }] };
    for (const [part, finishReason] of [[delta, null], [{}, complete ? "stop" : "tool_calls"]]) {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "qualification",
        choices: [{ index: 0, delta: part, finish_reason: finishReason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    const config = path.join(root, "opencode.json"), workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(config, JSON.stringify({ model: "openrouter/qualification", small_model: "openrouter/qualification",
      share: "disabled", autoupdate: false, plugin: [], enabled_providers: ["openrouter"],
      provider: { openrouter: { options: { baseURL: providerUrl, apiKey: "local-fixture-only" },
        models: { qualification: { name: "qualification", limit: { context: 100000, output: 1000 } } } } },
      permission: { "*": "deny", "paperclip_*": "allow" },
      mcp: { paperclip: { type: "remote", url: bridge.url, enabled: true, oauth: false,
        headers: { Authorization: `Bearer ${bridge.secret}` }, timeout: 5000 } },
    }));
    child = spawn(resolvePinnedOpenCodeCommand(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: workspace, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
        OPENCODE_CONFIG: config, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_SERVER_USERNAME: "paperclip", OPENCODE_SERVER_PASSWORD: "local-fixture-only" },
    });
    exited = once(child, "exit");
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", chunk => { rawOutput = `${rawOutput}${chunk}`.slice(-16384); });
    let baseUrl: string | undefined;
    for (let index = 0; index < 150; index++) {
      baseUrl = rawOutput.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (baseUrl) break;
      assert.equal(child.exitCode, null, rawOutput); await delay(100);
    }
    assert.ok(baseUrl, rawOutput);
    const headers = { Authorization: `Basic ${Buffer.from("paperclip:local-fixture-only").toString("base64")}`, "content-type": "application/json" };
    const api = async (route: string, options: RequestInit = {}) => {
      const response = await fetch(baseUrl + route, { headers, signal: AbortSignal.timeout(15_000), ...options });
      assert.ok(response.ok, `${route}:${response.status} ${await response.clone().text()}`); return response;
    };
    const session = await (await api("/session", { method: "POST", body: JSON.stringify({ title: "Local question schema" }) })).json() as Row;
    await api(`/session/${session.id}/prompt_async`, { method: "POST", body: JSON.stringify({
      model: { providerID: "openrouter", modelID: "qualification" }, parts: [{ type: "text", text: "Ask the time choice." }],
    }) });
    for (let index = 0; index < 150; index++) {
      const messages = await (await api(`/session/${session.id}/message`)).json() as Row[];
      if (messages.some(message => message.info.role === "assistant" && message.parts.some((part: Row) => part.type === "text" && part.text === "Question fixture done."))) break;
      await delay(100);
    }
    const offered = requests.find(request => request.body.tools)?.body.tools.find((tool: Row) => tool.function?.name === "paperclip_request_human_input");
    assert.equal(requests.length, 3);
    assert.ok(requests[1]!.body.messages.some((message: Row) => message.role === "tool" && String(message.content).includes("Invalid tool input")));
    assert.ok(offered, "Human input tool not offered");
    assert.deepEqual(calls, [input]);
  } finally {
    if (child?.pid) {
      const processId = child.pid;
      try { process.kill(-processId, "SIGTERM"); } catch {}
      const timer = setTimeout(() => { try { process.kill(-processId, "SIGKILL"); } catch {} }, 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await bridge.close(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
