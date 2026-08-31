#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.OPENROUTER_API_KEY) process.stderr.write(`fixture credential=${process.env.OPENROUTER_API_KEY}\n`);
const port = Number(args[args.indexOf("--port") + 1]);
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const session = { id: "ses_fake_1", title: "Paperclip fake" };
const clients = new Set();
let eventConnections = 0;
const runtimeConfig = JSON.parse(await readFile(join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"));
const mcp = runtimeConfig.mcp?.paperclip;
let mcpRequestId = 1;
const mcpEvidence = { tools: [], calls: [] };

function nativeQuestion() {
  return {
    id: "question-native-1",
    sessionID: session.id,
    questions: [
      {
        id: "environment",
        header: "Environment",
        question: "Where should we deploy?",
        options: [
          { label: "Staging", description: "Deploy to staging first." },
          { label: "Production", description: "Deploy directly to production." }
        ],
        custom: true
      },
      {
        id: "regions",
        header: "Regions",
        question: "Which regions?",
        options: [{ label: "US" }, { label: "EU" }],
        multiple: true
      }
    ]
  };
}

function nativePermission(style) {
  return style === "legacy"
    ? {
        id: "permission-native-1",
        type: "tool",
        pattern: "echo OK",
        sessionID: session.id,
        messageID: "message-permission",
        callID: "call-permission",
        title: "Run validation command",
        metadata: {},
        time: { created: Date.now() },
      }
    : {
        id: "permission-native-1",
        sessionID: session.id,
        permission: "bash",
        patterns: ["echo OK"],
        always: ["echo *"],
        metadata: {},
        tool: { messageID: "message-permission", callID: "call-permission" },
      };
}

let pendingQuestion = await readFile(join(process.env.XDG_DATA_HOME, "fake-pending-question.json"), "utf8")
  .then((value) => JSON.parse(value))
  .catch(() => null);
let pendingPermission = await readFile(join(process.env.XDG_DATA_HOME, "fake-pending-permission.json"), "utf8")
  .then((value) => JSON.parse(value))
  .catch(() => null);
let permissionStyle = "v2";

await mkdir(process.env.XDG_DATA_HOME, { recursive: true });
await writeFile(join(process.env.XDG_DATA_HOME, "fake-environment.json"), JSON.stringify({
  keys: Object.keys(process.env).sort(),
  home: process.env.HOME,
  configHome: process.env.XDG_CONFIG_HOME,
  projectConfigDisabled: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
}));

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

function emit(value) {
  const frame = `data: ${JSON.stringify(value)}\n\n`;
  for (const response of clients) response.write(frame);
}

async function mcpRequest(method, params) {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { ...mcp.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: mcpRequestId++, method, ...(params ? { params } : {}) }),
  });
  return response.json();
}

async function callFirstPaperclipTool() {
  if (!mcp?.url) return;
  await mcpRequest("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-opencode", version: "1" } });
  const listed = await mcpRequest("tools/list");
  mcpEvidence.tools = (listed.result?.tools ?? []).map((entry) => entry.name);
  const tool = listed.result?.tools?.find((entry) =>
    !["paperclip_finish", "paperclip_block"].includes(entry.name)
    && (entry.inputSchema?.required?.length ?? 0) === 0
  );
  if (tool) mcpEvidence.calls.push(await mcpRequest("tools/call", { name: `paperclip_${tool.name}`, arguments: {} }));
  await writeFile(join(process.env.XDG_DATA_HOME, "fake-mcp-evidence.json"), JSON.stringify(mcpEvidence));
}

async function callTerminalTool(promptBody) {
  const prompt = JSON.parse(promptBody.parts?.[0]?.text ?? "{}");
  const blocked = String(prompt.message ?? "").includes("block-result");
  const result = {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: blocked ? "blocked" : "done",
    summary: blocked ? "Fake provider is blocked." : "Fake provider completed the task.",
    completionClaim: {
      contractRevision: prompt.task?.completionContract?.revision ?? "codex-demo-v1",
      objectiveSatisfied: !blocked,
      criteria: (prompt.task?.completionContract?.criteria ?? []).map((criterion) => ({
        criterionId: criterion.id,
        status: blocked ? "unknown" : "satisfied",
        evidenceRefs: [],
      })),
      remainingWork: blocked ? [{ description: "Waiting on a test dependency.", blocksCompletion: true }] : [],
    },
    evidence: [],
    verification: [],
    attentionRequests: blocked ? [{ kind: "blocker", summary: "Waiting on a test dependency." }] : [],
    artifacts: [],
    ...(blocked ? { blocker: {
      reasonCode: "test_dependency",
      owner: { kind: "external", name: "fixture" },
      unblockAction: "Release the fixture dependency.",
      scope: "current_track",
    } } : {}),
  };
  return mcpRequest("tools/call", {
    name: blocked ? "paperclip_block" : "paperclip_finish",
    arguments: result,
  });
}

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== expectedAuth) return json(response, 401, { error: "unauthorized" });
  if (request.url === "/global/health") return json(response, 200, { healthy: true, version: "1.18.17" });
  if (request.url === "/event") {
    eventConnections += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    if (eventConnections === 1) {
      response.end();
      return;
    }
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && request.url === "/session") return json(response, 200, session);
  if (request.method === "GET" && request.url === `/session/${session.id}`) return json(response, 200, session);
  if (request.method === "GET" && request.url === `/session/${session.id}/message`) return json(response, 200, []);
  if (request.method === "GET" && request.url === "/session/status") return json(response, 200, { [session.id]: { type: "idle" } });
  if (request.method === "GET" && request.url?.startsWith("/question?")) return json(response, 200, pendingQuestion ? [pendingQuestion] : []);
  if (request.method === "GET" && request.url?.startsWith("/permission?")) return json(response, 200, pendingPermission ? [pendingPermission] : []);
  if (request.method === "POST" && request.url?.startsWith("/question/question-native-1/reply?")) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await writeFile(join(process.env.XDG_DATA_HOME, "fake-question-reply.json"), JSON.stringify({ url: request.url, body }));
      const repliedQuestion = pendingQuestion;
      pendingQuestion = null;
      emit({ type: "question.replied", id: "event-question-replied", properties: repliedQuestion });
      setTimeout(() => {
        json(response, 200, true);
        emit({ type: "session.idle", id: "event-question-idle", properties: { sessionID: session.id } });
      }, 10);
    });
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/question/question-native-1/reject?")) {
    const rejectedQuestion = pendingQuestion;
    pendingQuestion = null;
    emit({ type: "question.rejected", id: "event-question-rejected", properties: rejectedQuestion });
    setTimeout(() => {
      json(response, 200, true);
      emit({ type: "session.idle", id: "event-question-rejected-idle", properties: { sessionID: session.id } });
    }, 10);
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/permission/permission-native-1/reply?")) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await writeFile(join(process.env.XDG_DATA_HOME, "fake-permission-reply.json"), JSON.stringify({ url: request.url, body }));
      pendingPermission = null;
      emit({
        type: permissionStyle === "legacy" ? "permission.replied" : "permission.v2.replied",
        id: "event-permission-replied",
        properties: permissionStyle === "legacy"
          ? { sessionID: session.id, permissionID: "permission-native-1", response: body.reply }
          : { sessionID: session.id, requestID: "permission-native-1", reply: body.reply },
      });
      setTimeout(() => {
        json(response, 200, true);
        emit({ type: "session.idle", id: "event-permission-idle", properties: { sessionID: session.id } });
      }, 10);
    });
    return;
  }
  if (request.method === "POST" && request.url === `/session/${session.id}/abort`) return json(response, 200, true);
  if (request.method === "POST" && request.url === `/session/${session.id}/prompt_async`) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const promptPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (promptPayload.providerID !== "openrouter" || promptPayload.modelID !== "deepseek/deepseek-v4-flash-0731" || "model" in promptPayload) {
        return json(response, 400, { error: "OpenCode 1.18 prompt model fields must be top-level" });
      }
      json(response, 204, null);
      setTimeout(async () => {
        await callFirstPaperclipTool();
        const parsedPrompt = JSON.parse(promptPayload.parts?.[0]?.text ?? "{}");
        if (String(parsedPrompt.message ?? "").includes("native-question")) {
          pendingQuestion = nativeQuestion();
          emit({ type: "question.asked", id: "event-question-native-1", properties: pendingQuestion });
          emit({ type: "question.asked", id: "event-question-native-1", properties: pendingQuestion });
          return;
        }
        if (String(parsedPrompt.message ?? "").includes("native-permission")) {
          permissionStyle = String(parsedPrompt.message ?? "").includes("legacy") ? "legacy" : "v2";
          pendingPermission = nativePermission(permissionStyle);
          emit({
            type: permissionStyle === "legacy" ? "permission.updated" : "permission.v2.asked",
            id: `event-permission-${permissionStyle}`,
            properties: pendingPermission,
          });
          return;
        }
        if (String(parsedPrompt.message ?? "").includes("session-aborted")) {
          emit({
            type: "session.error",
            id: "event-session-aborted",
            properties: {
              sessionID: session.id,
              error: { name: "MessageAbortedError", data: { message: "Aborted" } },
            },
          });
          return;
        }
        const textBeforeFinish = String(parsedPrompt.message ?? "").includes("text-before-finish");
        const correlatedFinal = String(parsedPrompt.message ?? "").includes("correlated-final-message");
        const finalAfterToolCommentary = String(parsedPrompt.message ?? "").includes("final-after-tool-commentary");
        const commentaryOnlyBeforeWork = String(parsedPrompt.message ?? "").includes("commentary-only-before-work");
        emit({ type: "message.updated", id: "event-user", properties: { sessionID: session.id, info: { id: "message-user", sessionID: session.id, role: "user" } } });
        emit({ type: "message.part.updated", id: "event-user-part", properties: { sessionID: session.id, part: { id: "part-user", messageID: "message-user", type: "text", text: "submitted prompt must not become assistant text" } } });
        emit({ type: "message.updated", id: "event-assistant", properties: { sessionID: session.id, info: { id: "message-assistant", sessionID: session.id, role: "assistant" } } });
        emit({ type: "message.part.updated", id: "event-patch", properties: { sessionID: session.id, part: { id: "part-patch", messageID: "message-assistant", type: "patch", files: ["src/index.ts"] } } });
        if (commentaryOnlyBeforeWork) {
          emit({ type: "message.part.updated", id: "event-opening-commentary", properties: { sessionID: session.id, part: { id: "part-opening-commentary", messageID: "message-assistant", type: "text", text: "I will inspect the workspace first.", time: { start: 1, end: 2 } } } });
          emit({ type: "message.part.updated", id: "event-work-tool", properties: { sessionID: session.id, part: { id: "part-work-tool", messageID: "message-assistant", type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" }, output: "/workspace" } } } });
          await callTerminalTool(promptPayload);
        } else if (finalAfterToolCommentary) {
          emit({ type: "message.part.updated", id: "event-tool-commentary", properties: { sessionID: session.id, part: { id: "part-tool-commentary", messageID: "message-assistant", type: "text", text: "The schema might need another value; I will try again.", time: { start: 1, end: 2 } } } });
          await callTerminalTool(promptPayload);
          emit({ type: "message.part.updated", id: "event-tool-part", properties: { sessionID: session.id, part: { id: "part-tool", messageID: "message-assistant", type: "tool", tool: "paperclip_paperclip_finish", state: { status: "completed", output: "accepted" } } } });
          emit({ type: "message.updated", id: "event-post-tool-final-message", properties: { sessionID: session.id, info: { id: "message-post-tool-final", sessionID: session.id, role: "assistant" } } });
          emit({ type: "message.part.updated", id: "event-post-tool-final", properties: { sessionID: session.id, part: { id: "part-post-tool-final", messageID: "message-post-tool-final", type: "text", text: "This is the complete substantive answer emitted after the accepted completion tool call.", time: { start: 3, end: 4 } } } });
        } else if (correlatedFinal) {
          emit({ type: "message.part.updated", id: "event-commentary", properties: { sessionID: session.id, part: { id: "part-commentary", messageID: "message-assistant", type: "text", text: "I will write the result now.", time: { start: 1, end: 2 } } } });
          await callTerminalTool(promptPayload);
          emit({ type: "message.updated", id: "event-final-message", properties: { sessionID: session.id, info: { id: "message-final", sessionID: session.id, role: "assistant" } } });
          emit({ type: "message.part.updated", id: "event-finish-part", properties: { sessionID: session.id, part: { id: "part-finish", messageID: "message-final", type: "tool", tool: "paperclip_paperclip_finish", state: { status: "completed", output: "accepted" } } } });
          emit({ type: "message.part.updated", id: "event-correlated-answer", properties: { sessionID: session.id, part: { id: "part-correlated-answer", messageID: "message-final", type: "text", text: "Correlated substantive final answer.", time: { start: 3, end: 4 } } } });
          emit({ type: "message.part.updated", id: "event-duplicate-finish", properties: { sessionID: session.id, part: { id: "part-duplicate-finish", messageID: "message-final", type: "tool", tool: "unknown", callID: "functions.paperclip_paperclip_finish:24", state: { status: "error", error: "Tool execution aborted", metadata: { interrupted: true } } } } });
          emit({ type: "message.updated", id: "event-trailing-message", properties: { sessionID: session.id, info: { id: "message-trailing", sessionID: session.id, role: "assistant" } } });
          emit({ type: "message.part.updated", id: "event-trailing-ack", properties: { sessionID: session.id, part: { id: "part-trailing-ack", messageID: "message-trailing", type: "text", text: "Done.", time: { start: 5, end: 6 } } } });
        } else if (textBeforeFinish) {
          emit({ type: "message.part.updated", id: "event-answer", properties: { sessionID: session.id, part: { id: "part-answer", messageID: "message-assistant", type: "text", text: "Substantive answer before finish.", time: { start: 1, end: 2 } } } });
          await callTerminalTool(promptPayload);
          emit({ type: "message.part.updated", id: "event-ack", properties: { sessionID: session.id, part: { id: "part-ack", messageID: "message-assistant", type: "text", text: "Done.", time: { start: 3, end: 4 } } } });
        } else {
          await callTerminalTool(promptPayload);
          emit({ type: "message.part.updated", id: "event-1", properties: { sessionID: session.id, part: { id: "part-1", messageID: "message-assistant", type: "text", text: "done [guide](guide.md)", time: { start: 1, end: 2 } } } });
          emit({ type: "message.part.updated", id: "event-1", properties: { sessionID: session.id, part: { id: "part-1", messageID: "message-assistant", type: "text", text: "done" } } });
        }
        emit({ type: "message.updated", id: "event-2", properties: { info: { id: "message-assistant", sessionID: session.id, role: "assistant", tokens: { input: 3, output: 2 }, cost: 0.001 } } });
        emit({ type: "session.idle", id: "event-3", properties: { sessionID: session.id } });
      }, 100);
    });
    return;
  }
  json(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
