#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
// Exercise diagnostic redaction without copying a real environment credential
// into stderr or the provider trace.
process.stderr.write("authorization=synthetic-redaction-sentinel\n");
const port = Number(args[args.indexOf("--port") + 1]);
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const session = { id: "ses_fake_1", title: "Paperclip fake" };
const clients = new Set();
let eventConnections = 0;
const runtimeConfig = JSON.parse(
  await readFile(
    join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
    "utf8",
  ),
);
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
          {
            label: "Production",
            description: "Deploy directly to production.",
          },
        ],
        custom: true,
      },
      {
        id: "regions",
        header: "Regions",
        question: "Which regions?",
        options: [{ label: "US" }, { label: "EU" }],
        multiple: true,
      },
    ],
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

let pendingQuestion = await readFile(
  join(process.env.XDG_DATA_HOME, "fake-pending-question.json"),
  "utf8",
)
  .then((value) => JSON.parse(value))
  .catch(() => null);
let pendingPermission = await readFile(
  join(process.env.XDG_DATA_HOME, "fake-pending-permission.json"),
  "utf8",
)
  .then((value) => JSON.parse(value))
  .catch(() => null);
let permissionStyle = "v2";

await mkdir(process.env.XDG_DATA_HOME, { recursive: true });
await writeFile(
  join(process.env.XDG_DATA_HOME, "fake-environment.json"),
  JSON.stringify({
    keys: Object.keys(process.env).sort(),
    home: process.env.HOME,
    configHome: process.env.XDG_CONFIG_HOME,
    projectConfigDisabled: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    modelsFetchDisabled: process.env.OPENCODE_DISABLE_MODELS_FETCH,
    defaultPluginsDisabled: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS,
  }),
);

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

// Each simulated turn reuses the same short event ids ("event-1",
// "event-3", and so on). OpenCode's real event ids are unique, and the
// driver relies on that to drop a duplicate delivery of the same event.
// Scope every event id to the turn that produced it so a second turn's
// events do not look like duplicates of the first turn's events.
let promptTurnSeq = 0;
// Set by a "late-straggler-source" turn to simulate a distinct provider
// frame for that turn's message arriving only after a later turn's prompt
// has already been accepted. Counts down by one on each subsequent prompt
// request and flushes at the start of the request that brings it to zero.
// A plain "late-straggler-source" message flushes on the very next prompt
// (delay 1); "late-straggler-source-delay-N" flushes N prompts later, so a
// test can place the stale frame's arrival after several more turns have
// sealed.
let lateStragglerRemaining = 0;
function emit(value) {
  const scoped =
    promptTurnSeq > 0 && typeof value.id === "string"
      ? { ...value, id: `${value.id}#${promptTurnSeq}` }
      : value;
  const frame = `data: ${JSON.stringify(scoped)}\n\n`;
  for (const response of clients) response.write(frame);
}

function parsedPromptText(promptBody) {
  const text = promptBody.parts?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function mcpRequest(method, params) {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: {
      ...mcp.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mcpRequestId++,
      method,
      ...(params ? { params } : {}),
    }),
  });
  return response.json();
}

async function callFirstPaperclipTool() {
  if (!mcp?.url) return;
  await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fake-opencode", version: "1" },
  });
  const listed = await mcpRequest("tools/list");
  mcpEvidence.tools = (listed.result?.tools ?? []).map((entry) => entry.name);
  const tool = listed.result?.tools?.find(
    (entry) =>
      !["paperclip_finish", "paperclip_block"].includes(entry.name) &&
      (entry.inputSchema?.required?.length ?? 0) === 0,
  );
  if (tool)
    mcpEvidence.calls.push(
      await mcpRequest("tools/call", {
        name: `paperclip_${tool.name}`,
        arguments: {},
      }),
    );
  await writeFile(
    join(process.env.XDG_DATA_HOME, "fake-mcp-evidence.json"),
    JSON.stringify(mcpEvidence),
  );
}

async function callTerminalTool(promptBody) {
  const prompt = parsedPromptText(promptBody);
  const blocked = String(prompt.message ?? "").includes("block-result");
  const result = {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: blocked ? "blocked" : "done",
    summary: blocked
      ? "Fake provider is blocked."
      : "Fake provider completed the task.",
    completionClaim: {
      contractRevision:
        prompt.completionContract?.revision ?? prompt.task?.completionContract?.revision ?? "codex-demo-v1",
      objectiveSatisfied: !blocked,
      criteria: (prompt.completionContract?.criteria ?? prompt.task?.completionContract?.criteria ?? []).map(
        (criterion) => ({
          criterionId: criterion.id,
          status: blocked ? "unknown" : "satisfied",
          evidenceRefs: [],
        }),
      ),
      remainingWork: blocked
        ? [
            {
              description: "Waiting on a test dependency.",
              blocksCompletion: true,
            },
          ]
        : [],
    },
    evidence: [],
    verification: [],
    attentionRequests: blocked
      ? [{ kind: "blocker", summary: "Waiting on a test dependency." }]
      : [],
    artifacts: [],
    ...(blocked
      ? {
          blocker: {
            reasonCode: "test_dependency",
            owner: { kind: "external", name: "fixture" },
            unblockAction: "Release the fixture dependency.",
            scope: "current_track",
          },
        }
      : {}),
  };
  if (String(prompt.message ?? "").includes("repair-criteria")) {
    const bad = structuredClone(result);
    bad.completionClaim.criteria = String(prompt.message).includes("repair-criteria-missing") ? []
      : String(prompt.message).includes("repair-criteria-duplicate") ? [...result.completionClaim.criteria, ...result.completionClaim.criteria]
      : [{ criterionId: "invented", status: "satisfied", evidenceRefs: [] }];
    const rejected = await mcpRequest("tools/call", { name: "paperclip_finish", arguments: bad });
    await writeFile(join(process.env.XDG_DATA_HOME, "fake-criteria-repair.json"), JSON.stringify(rejected));
  }
  const call = () => mcpRequest("tools/call", {
    name: blocked ? "paperclip_block" : "paperclip_finish",
    arguments: result,
  });
  const first = await call();
  if (String(prompt.message ?? prompt.task?.prompt ?? "").includes("completion-feedback")) {
    const outcomes = [first];
    if (first.result?.isError) outcomes.push(await call());
    await writeFile(join(process.env.XDG_DATA_HOME, "fake-completion-feedback.json"), JSON.stringify(outcomes));
    return outcomes.at(-1);
  }
  return first;
}

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== expectedAuth)
    return json(response, 401, { error: "unauthorized" });
  if (request.url === "/global/health")
    return json(response, 200, { healthy: true, version: "1.18.34" });
  if (request.url === "/event") {
    eventConnections += 1;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    response.write(
      `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
    );
    if (eventConnections === 1) {
      response.end();
      return;
    }
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && request.url === "/session")
    return json(response, 200, session);
  if (request.method === "GET" && request.url === `/session/${session.id}`)
    return json(response, 200, session);
  if (
    request.method === "GET" &&
    request.url === `/session/${session.id}/message`
  )
    return json(response, 200, []);
  if (request.method === "GET" && request.url === "/session/status")
    return json(response, 200, { [session.id]: { type: "idle" } });
  if (request.method === "GET" && request.url?.startsWith("/question?"))
    return json(response, 200, pendingQuestion ? [pendingQuestion] : []);
  if (request.method === "GET" && request.url?.startsWith("/permission?"))
    return json(response, 200, pendingPermission ? [pendingPermission] : []);
  if (
    request.method === "POST" &&
    request.url?.startsWith("/question/question-native-1/reply?")
  ) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await writeFile(
        join(process.env.XDG_DATA_HOME, "fake-question-reply.json"),
        JSON.stringify({ url: request.url, body }),
      );
      const repliedQuestion = pendingQuestion;
      pendingQuestion = null;
      emit({
        type: "question.replied",
        id: "event-question-replied",
        properties: repliedQuestion,
      });
      setTimeout(() => {
        json(response, 200, true);
        emit({
          type: "session.idle",
          id: "event-question-idle",
          properties: { sessionID: session.id },
        });
      }, 10);
    });
    return;
  }
  if (
    request.method === "POST" &&
    request.url?.startsWith("/question/question-native-1/reject?")
  ) {
    const rejectedQuestion = pendingQuestion;
    pendingQuestion = null;
    emit({
      type: "question.rejected",
      id: "event-question-rejected",
      properties: rejectedQuestion,
    });
    setTimeout(() => {
      json(response, 200, true);
      emit({
        type: "session.idle",
        id: "event-question-rejected-idle",
        properties: { sessionID: session.id },
      });
    }, 10);
    return;
  }
  if (
    request.method === "POST" &&
    request.url?.startsWith("/permission/permission-native-1/reply?")
  ) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await writeFile(
        join(process.env.XDG_DATA_HOME, "fake-permission-reply.json"),
        JSON.stringify({ url: request.url, body }),
      );
      pendingPermission = null;
      emit({
        type:
          permissionStyle === "legacy"
            ? "permission.replied"
            : "permission.v2.replied",
        id: "event-permission-replied",
        properties:
          permissionStyle === "legacy"
            ? {
                sessionID: session.id,
                permissionID: "permission-native-1",
                response: body.reply,
              }
            : {
                sessionID: session.id,
                requestID: "permission-native-1",
                reply: body.reply,
              },
      });
      setTimeout(() => {
        json(response, 200, true);
        emit({
          type: "session.idle",
          id: "event-permission-idle",
          properties: { sessionID: session.id },
        });
      }, 10);
    });
    return;
  }
  if (
    request.method === "POST" &&
    request.url === `/session/${session.id}/abort`
  )
    return json(response, 200, true);
  if (
    request.method === "POST" &&
    request.url === `/session/${session.id}/prompt_async`
  ) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const promptPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await appendFile(join(process.env.XDG_DATA_HOME, "fake-prompt-requests.ndjson"), JSON.stringify(promptPayload) + "\n");
      if (
        promptPayload.providerID !== "openrouter" ||
        promptPayload.modelID !== "deepseek/deepseek-v4-flash-0731" ||
        "model" in promptPayload
      ) {
        return json(response, 400, {
          error: "OpenCode 1.18 prompt model fields must be top-level",
        });
      }
      promptTurnSeq += 1;
      json(response, 204, null);
      if (lateStragglerRemaining > 0) {
        lateStragglerRemaining -= 1;
        if (lateStragglerRemaining === 0) {
          emit({
            type: "message.part.updated",
            id: "event-late-straggler-delivery",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-late-straggler",
                messageID: "message-late-source",
                type: "text",
                text: "late straggler text must not reach the next turn",
                time: { start: 9, end: 10 },
              },
            },
          });
          emit({
            type: "message.part.delta",
            properties: {
              sessionID: session.id,
              messageID: "message-late-source",
              partID: "part-late-straggler",
              field: "text",
              delta: "late straggler text must not reach the next turn",
            },
          });
        }
      }
      setTimeout(async () => {
        await callFirstPaperclipTool();
        const parsedPrompt = parsedPromptText(promptPayload);
        if (String(parsedPrompt.message ?? "").includes("incremental-stream")) {
          const messageID = `stream-message-${promptTurnSeq}`;
          const part = { id: `stream-part-${promptTurnSeq}`, messageID, sessionID: session.id, type: "text", text: "" };
          const reasoning = { ...part, id: `${part.id}-reasoning`, type: "reasoning" };
          const update = (value) => emit({ type: "message.part.updated", properties: { sessionID: session.id, part: value } });
          const delta = (value, text, extra = {}) => emit({ type: "message.part.delta", properties: { sessionID: session.id, messageID, partID: value.id, field: "text", delta: text, ...extra } });
          const announceRole = () => emit({ type: "message.updated", properties: { sessionID: session.id, info: { id: messageID, role: "assistant" } } });
          const roleFirst = String(parsedPrompt.message).includes("role-first");
          if (roleFirst) announceRole();
          // Parts and deltas can precede the message's role announcement.
          update(part);
          update(reasoning);
          delta(reasoning, "Thinking");
          delta(part, "Hi ");
          delta(part, "👋");
          delta(part, "👋");
          delta(part, "wrong message", { messageID: "unrelated-message" });
          delta(part, "wrong session", { sessionID: "unrelated-session" });
          delta(part, "wrong field", { field: "output" });
          delta(part, "unknown part", { partID: "unknown-part" });
          if (!roleFirst) announceRole();
          // The consumer must observe a delta before the completed snapshot
          // exists. This handshake makes the streaming regression deterministic.
          for (let i = 0; i < 500; i++) {
            if (await readFile(join(process.env.XDG_DATA_HOME, "release-stream"), "utf8").catch(() => "") === "ready") break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          update({ ...part, text: "Hi 👋👋", time: { start: 1, end: 2 } });
          emit({ type: "session.idle", properties: { sessionID: session.id } });
          return;
        }
        if (String(parsedPrompt.message ?? "").includes("native-question")) {
          pendingQuestion = nativeQuestion();
          emit({
            type: "question.asked",
            id: "event-question-native-1",
            properties: pendingQuestion,
          });
          emit({
            type: "question.asked",
            id: "event-question-native-1",
            properties: pendingQuestion,
          });
          return;
        }
        if (String(parsedPrompt.message ?? "").includes("native-permission")) {
          permissionStyle = String(parsedPrompt.message ?? "").includes(
            "legacy",
          )
            ? "legacy"
            : "v2";
          pendingPermission = nativePermission(permissionStyle);
          emit({
            type:
              permissionStyle === "legacy"
                ? "permission.updated"
                : "permission.v2.asked",
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
              error: {
                name: "MessageAbortedError",
                data: { message: "Aborted" },
              },
            },
          });
          return;
        }
        if (String(parsedPrompt.message ?? "").includes("session-failed")) {
          emit({
            type: "session.error",
            id: "event-session-failed",
            properties: {
              sessionID: session.id,
              error: {
                name: "ProviderError",
                message: "The fake provider failed on purpose.",
              },
            },
          });
          return;
        }
        if (
          String(parsedPrompt.message ?? "").includes(
            "pending-request-then-turn-fails",
          )
        ) {
          pendingQuestion = nativeQuestion();
          emit({
            type: "question.asked",
            id: "event-question-pending-then-fail",
            properties: pendingQuestion,
          });
          setTimeout(() => {
            emit({
              type: "session.error",
              id: "event-session-failed-with-pending-request",
              properties: {
                sessionID: session.id,
                error: {
                  name: "ProviderError",
                  message: "The fake provider failed with a request still pending.",
                },
              },
            });
          }, 10);
          return;
        }
        if (
          String(parsedPrompt.message ?? "").includes("late-straggler-source")
        ) {
          emit({
            type: "message.updated",
            id: "event-late-source-message",
            properties: {
              sessionID: session.id,
              info: {
                id: "message-late-source",
                sessionID: session.id,
                role: "assistant",
              },
            },
          });
          await callTerminalTool(promptPayload);
          emit({
            type: "message.part.updated",
            id: "event-late-source-part",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-late-source",
                messageID: "message-late-source",
                type: "text",
                text: "done",
                time: { start: 1, end: 2 },
              },
            },
          });
          emit({
            type: "message.updated",
            id: "event-late-source-usage",
            properties: {
              info: {
                id: "message-late-source",
                sessionID: session.id,
                role: "assistant",
                tokens: { input: 3, output: 2 },
                cost: 0.001,
              },
            },
          });
          emit({
            type: "session.idle",
            id: "event-late-source-idle",
            properties: { sessionID: session.id },
          });
          // Deliver the straggling frame for this message only once a later
          // turn's own prompt has already been accepted. Defaults to the
          // very next prompt; "-delay-N" postpones it by N prompts.
          const delayMatch = String(parsedPrompt.message ?? "").match(
            /late-straggler-source-delay-(\d+)/,
          );
          lateStragglerRemaining = delayMatch ? Number(delayMatch[1]) : 1;
          return;
        }
        const textBeforeFinish = String(parsedPrompt.message ?? "").includes(
          "text-before-finish",
        );
        const correlatedFinal = String(parsedPrompt.message ?? "").includes(
          "correlated-final-message",
        );
        const finalAfterToolCommentary = String(
          parsedPrompt.message ?? "",
        ).includes("final-after-tool-commentary");
        const commentaryOnlyBeforeWork = String(
          parsedPrompt.message ?? "",
        ).includes("commentary-only-before-work");
        emit({
          type: "message.updated",
          id: "event-user",
          properties: {
            sessionID: session.id,
            info: { id: "message-user", sessionID: session.id, role: "user" },
          },
        });
        emit({
          type: "message.part.updated",
          id: "event-user-part",
          properties: {
            sessionID: session.id,
            part: {
              id: "part-user",
              messageID: "message-user",
              type: "text",
              text: "submitted prompt must not become assistant text",
            },
          },
        });
        emit({
          type: "message.updated",
          id: "event-assistant",
          properties: {
            sessionID: session.id,
            info: {
              id: "message-assistant",
              sessionID: session.id,
              role: "assistant",
            },
          },
        });
        if (String(parsedPrompt.message ?? parsedPrompt.task?.prompt ?? "").includes("invalid-tool-feedback")) {
          for (const [status, state] of [
            ["pending", {}], ["running", { title: "Checking tool name" }],
            ["error", { error: "Tool not found: fixture_missing" }],
          ]) emit({ type: "message.part.updated", id: `event-invalid-${status}`, properties: {
            sessionID: session.id, part: { id: "part-invalid", messageID: "message-assistant",
              type: "tool", tool: "invalid", callID: "call-invalid", state: { status, ...state } },
          } });
        }
        emit({
          type: "message.part.updated",
          id: "event-patch",
          properties: {
            sessionID: session.id,
            part: {
              id: "part-patch",
              messageID: "message-assistant",
              type: "patch",
              files: ["src/index.ts"],
            },
          },
        });
        if (commentaryOnlyBeforeWork) {
          emit({
            type: "message.part.updated",
            id: "event-opening-commentary",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-opening-commentary",
                messageID: "message-assistant",
                type: "text",
                text: "I will inspect the workspace first.",
                time: { start: 1, end: 2 },
              },
            },
          });
          emit({
            type: "message.part.updated",
            id: "event-work-tool",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-work-tool",
                messageID: "message-assistant",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "/workspace",
                },
              },
            },
          });
          await callTerminalTool(promptPayload);
        } else if (finalAfterToolCommentary) {
          emit({
            type: "message.part.updated",
            id: "event-tool-commentary",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-tool-commentary",
                messageID: "message-assistant",
                type: "text",
                text: "This deliberately long pre-tool commentary discusses possible schema corrections, retries, compatibility details, and several implementation alternatives, but it is not the provider's final response.",
                time: { start: 1, end: 2 },
              },
            },
          });
          await callTerminalTool(promptPayload);
          emit({
            type: "message.part.updated",
            id: "event-tool-part",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-tool",
                messageID: "message-assistant",
                type: "tool",
                tool: "paperclip_paperclip_finish",
                state: { status: "completed", output: "accepted" },
              },
            },
          });
          emit({
            type: "message.updated",
            id: "event-post-tool-final-message",
            properties: {
              sessionID: session.id,
              info: {
                id: "message-post-tool-final",
                sessionID: session.id,
                role: "assistant",
              },
            },
          });
          emit({
            type: "message.part.updated",
            id: "event-post-tool-final",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-post-tool-final",
                messageID: "message-post-tool-final",
                type: "text",
                text: "This is the complete substantive answer emitted after the accepted completion tool call.",
                time: { start: 3, end: 4 },
              },
            },
          });
        } else if (correlatedFinal) {
          emit({
            type: "message.part.updated",
            id: "event-commentary",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-commentary",
                messageID: "message-assistant",
                type: "text",
                text: "I will write the result now.",
                time: { start: 1, end: 2 },
              },
            },
          });
          await callTerminalTool(promptPayload);
          emit({
            type: "message.updated",
            id: "event-final-message",
            properties: {
              sessionID: session.id,
              info: {
                id: "message-final",
                sessionID: session.id,
                role: "assistant",
              },
            },
          });
          emit({
            type: "message.part.updated",
            id: "event-finish-part",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-finish",
                messageID: "message-final",
                type: "tool",
                tool: "paperclip_paperclip_finish",
                state: { status: "completed", output: "accepted" },
              },
            },
          });
          emit({
            type: "message.part.updated",
            id: "event-correlated-answer",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-correlated-answer",
                messageID: "message-final",
                type: "text",
                text: "Correlated substantive final answer.",
                time: { start: 3, end: 4 },
              },
            },
          });
          emit({
            type: "message.part.updated",
            id: "event-duplicate-finish",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-duplicate-finish",
                messageID: "message-final",
                type: "tool",
                tool: "unknown",
                callID: "functions.paperclip_paperclip_finish:24",
                state: {
                  status: "error",
                  error: "Tool execution aborted",
                  metadata: { interrupted: true },
                },
              },
            },
          });
          emit({
            type: "message.updated",
            id: "event-trailing-message",
            properties: {
              sessionID: session.id,
              info: {
                id: "message-trailing",
                sessionID: session.id,
                role: "assistant",
              },
            },
          });
          emit({
            type: "message.part.updated",
            id: "event-trailing-ack",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-trailing-ack",
                messageID: "message-trailing",
                type: "text",
                text: "Done.",
                time: { start: 5, end: 6 },
              },
            },
          });
        } else if (textBeforeFinish) {
          emit({
            type: "message.part.updated",
            id: "event-answer",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-answer",
                messageID: "message-assistant",
                type: "text",
                text: "Substantive answer before finish.",
                time: { start: 1, end: 2 },
              },
            },
          });
          await callTerminalTool(promptPayload);
          emit({
            type: "message.part.updated",
            id: "event-ack",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-ack",
                messageID: "message-assistant",
                type: "text",
                text: "Done.",
                time: { start: 3, end: 4 },
              },
            },
          });
        } else {
          await callTerminalTool(promptPayload);
          emit({
            type: "message.part.updated",
            id: "event-1",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-1",
                messageID: "message-assistant",
                type: "text",
                text: "done [guide](guide.md)",
                time: { start: 1, end: 2 },
              },
            },
          });
          emit({
            type: "message.part.updated",
            id: "event-1",
            properties: {
              sessionID: session.id,
              part: {
                id: "part-1",
                messageID: "message-assistant",
                type: "text",
                text: "done",
              },
            },
          });
        }
        emit({
          type: "message.updated",
          id: "event-2",
          properties: {
            info: {
              id: "message-assistant",
              sessionID: session.id,
              role: "assistant",
              tokens: { input: 3, output: 2 },
              cost: 0.001,
            },
          },
        });
        emit({
          type: "session.idle",
          id: "event-3",
          properties: { sessionID: session.id },
        });
      }, 100);
    });
    return;
  }
  json(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
