#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  HarnessRuntimeRequestResolution,
  HarnessSession,
  PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import { OpenCodeServerDriver } from "../drivers/opencode/opencode-server-driver.js";
import { parseNativeRuntimeContext } from "../contracts/runtime-context.js";
import { openCodeProxyTaskEnvelope } from "./opencode-proxy-task-envelope.js";
import {
  openCodeProxyItemNotification,
  openCodeProxyTerminalNotification,
  shouldAnnounceOpenCodeProxyTurn,
  shouldForwardOpenCodeProxyItem,
} from "./opencode-proxy-events.js";
import { enqueueOpenCodeProxyInput } from "./opencode-proxy-input.js";
import {
  assertOpenCodeProxyCollaborationMode,
  openCodeProxyCollaborationModes,
} from "./opencode-proxy-collaboration-mode.js";
import { parseOpenCodeProxyPermissionMode } from "./opencode-proxy-permission-mode.js";
import {
  trustedOpenCodeLaunchBinding,
  withoutAmbientOpenCodeCommand,
} from "./opencode-proxy-command.js";
import { OpenCodeProxyUsageLedger } from "./opencode-proxy-usage.js";

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
let nextServerRequestId = 1;
let driver: OpenCodeServerDriver | null = null;
let session: HarnessSession | null = null;
let eventPump: Promise<void> | null = null;
let cwd = "";
let activeModel = "";
let activeTurnId: string | null = null;
const announcedTurnIds = new Set<string>();
const launchBinding = trustedOpenCodeLaunchBinding(process.argv.slice(2));
const usageLedger = new OpenCodeProxyUsageLedger();

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requestController(method: string, params: unknown): Promise<unknown> {
  const id = `opencode-${nextServerRequestId++}`;
  send({ id, method, params });
  return new Promise((resolveValue, reject) =>
    pending.set(id, { resolve: resolveValue, reject }),
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function runtimeDirectory(): string {
  const configured = process.env.PAPERCLIP_OPENCODE_RUNTIME_DIR?.trim();
  if (!configured)
    throw new Error("PAPERCLIP_OPENCODE_RUNTIME_DIR is required");
  return resolve(configured);
}

async function open(
  params: Record<string, unknown>,
  resume: boolean,
): Promise<Record<string, unknown>> {
  if (session)
    return threadResponse(
      session.ids().providerSessionId ?? session.ids().driverSessionId,
    );
  cwd = resolve(text(params.cwd, process.cwd()));
  const model = text(params.model);
  if (!model.includes("/"))
    throw new Error("OpenCode proxy requires model in provider/model form");
  activeModel = model;
  const dynamicTools = Array.isArray(params.dynamicTools)
    ? params.dynamicTools.map(record)
    : [];
  const runtimeContextPath =
    process.env.PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH?.trim();
  const runtimeContext = runtimeContextPath
    ? parseNativeRuntimeContext(
        JSON.parse(readFileSync(runtimeContextPath, "utf8")),
      )
    : null;
  driver = new OpenCodeServerDriver({
    model,
    permissionMode: parseOpenCodeProxyPermissionMode(
      process.env.PAPERCLIP_OPENCODE_PERMISSION_MODE,
    ),
    command: launchBinding.command,
    commandFd: launchBinding.commandFd,
    commandLifecycle: launchBinding.commandLifecycle,
    runtimeDirectory: runtimeDirectory(),
    environment: withoutAmbientOpenCodeCommand(process.env),
    runnerInstanceId:
      process.env.PAPERCLIP_RUNNER_INSTANCE_ID ?? "paperclip-runnerd-opencode",
    taskEnvelope: openCodeProxyTaskEnvelope(params),
    systemInstructions: text(
      params.baseInstructions,
      "Complete only the supplied task.",
    ),
    runtimeContext,
    dynamicTools,
    dynamicToolHandler: async (call) =>
      requestController("item/tool/call", {
        threadId: session?.ids().driverSessionId ?? "opening",
        turnId: call.turnId,
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments,
      }),
    onDiagnostic: (message) => process.stderr.write(`[opencode] ${message}\n`),
    // runnerd gives this proxy its own process group. Keep `opencode serve` in
    // that same group so runnerd's TERM/KILL fallback cannot orphan it.
    isolateProcessGroup: false,
  });
  if (resume) {
    const threadId = text(params.threadId);
    const snapshot: PersistedHarnessSession = {
      driverKind: "opencode_server",
      driverSessionId: threadId,
      providerSessionId: threadId,
      runId: process.env.PAPERCLIP_RUN_ID ?? "runnerd-run",
      normalizedSessionId:
        process.env.PAPERCLIP_NORMALIZED_SESSION_ID ?? threadId,
      activeTurnId: null,
      lastSourceSequence: 0,
    };
    const recovered = await driver.recoverSession(snapshot);
    if (!recovered.recovered || !recovered.session)
      throw new Error(recovered.reason ?? "OpenCode recovery failed");
    session = recovered.session;
  } else {
    session = await driver.openSession({
      runId: process.env.PAPERCLIP_RUN_ID ?? "runnerd-run",
      normalizedSessionId:
        process.env.PAPERCLIP_NORMALIZED_SESSION_ID ?? `runnerd-${Date.now()}`,
      workingDirectory: cwd,
    });
  }
  eventPump = pumpEvents(session);
  void eventPump.catch((error) => failProxy(error));
  return threadResponse(
    session.ids().providerSessionId ?? session.ids().driverSessionId,
  );
}

function threadResponse(id: string): Record<string, unknown> {
  return { thread: { id, sessionId: id, cwd }, model: activeModel };
}

function announceTurnStarted(opened: HarnessSession, turnId: string): void {
  if (!shouldAnnounceOpenCodeProxyTurn(announcedTurnIds, turnId)) return;
  send({
    method: "turn/started",
    params: {
      threadId: opened.ids().driverSessionId,
      turnId,
      turn: { id: turnId, status: "inProgress" },
    },
  });
}

async function pumpEvents(opened: HarnessSession): Promise<void> {
  for await (const event of opened.events()) {
    const payload = record(event.payload);
    if (event.eventType === "turn.started") {
      if (typeof event.turnId === "string")
        announceTurnStarted(opened, event.turnId);
    } else if (
      event.eventType === "item.started" ||
      event.eventType === "item.delta" ||
      event.eventType === "item.completed"
    ) {
      // The inner OpenCode driver publishes session-scoped model metadata as
      // an item before any turn exists. The outer Codex protocol facade emits
      // its own model item, so forwarding this unbound duplicate would quite
      // correctly trip the facade's strict turn-binding validator.
      if (
        !shouldForwardOpenCodeProxyItem({
          turnId: event.turnId,
          kind: payload.kind,
        })
      )
        continue;
      send(
        openCodeProxyItemNotification({
          eventType: event.eventType,
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          payload,
        }),
      );
      if (payload.kind === "usage") {
        const usage = usageLedger.update({
          turnId: text(event.turnId),
          messageId: text(payload.usageMessageId),
          usage: payload.usage,
        });
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: opened.ids().driverSessionId,
            turnId: event.turnId,
            tokenUsage: usage,
          },
        });
      }
    } else if (event.eventType === "run.result.proposed") {
      send({
        method: "paperclip/runResult",
        params: {
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          itemId: event.itemId ?? "semantic-result",
          result: payload,
        },
      });
    } else if (event.eventType === "runtime_request.created") {
      const request = record(payload.request);
      const requestId = text(request.requestId);
      const turnId = text(
        request.turnId,
        text(event.turnId, activeTurnId ?? ""),
      );
      if (!requestId || !turnId || !opened.resolveRuntimeRequest) {
        throw new Error("OpenCode runtime request is not resolvable");
      }
      // Keep consuming OpenCode SSE while the controller waits for the user.
      // If the underlying provider disappears, the stream can then fail the
      // proxy and runnerd will expire the still-pending canonical request.
      void (async () => {
        const controllerResponse = record(
          await requestController("paperclip/runtimeRequest", {
            request,
          }),
        );
        await opened.resolveRuntimeRequest!({
          requestId,
          turnId,
          resolution: record(
            controllerResponse.resolution,
          ) as HarnessRuntimeRequestResolution,
        });
      })().catch((error) => failProxy(error));
    } else if (event.eventType === "run.attached") {
      // OpenCode can retain one provider session across governed runs. Usage
      // totals are run-scoped, so a new attachment must not inherit the prior
      // run's completed-turn ledger.
      usageLedger.reset();
    } else if (
      [
        "turn.completed",
        "turn.failed",
        "turn.interrupted",
        "turn.cancelled",
      ].includes(event.eventType)
    ) {
      if (typeof event.turnId === "string")
        usageLedger.completeTurn(event.turnId);
      send(
        openCodeProxyTerminalNotification({
          eventType: event.eventType as
            | "turn.completed"
            | "turn.failed"
            | "turn.interrupted"
            | "turn.cancelled",
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          payload,
        }),
      );
      activeTurnId = null;
    } else if (event.eventType === "harness.diagnostic") {
      send({
        method: "warning",
        params: {
          threadId: opened.ids().driverSessionId,
          message: payload.message ?? payload.code,
        },
      });
    }
  }
}

async function handle(message: RpcMessage): Promise<void> {
  if (message.method === undefined && message.id !== undefined) {
    const waiter = pending.get(String(message.id));
    if (!waiter) return;
    pending.delete(String(message.id));
    if (message.error !== undefined)
      waiter.reject(new Error(JSON.stringify(message.error)));
    else {
      const contentItems = record(message.result).contentItems;
      waiter.resolve(
        Array.isArray(contentItems)
          ? (contentItems[0] ?? message.result)
          : message.result,
      );
    }
    return;
  }
  if (!message.method || message.id === undefined) return;
  const params = record(message.params);
  let result: unknown;
  switch (message.method) {
    case "initialize":
      result = {
        user: { sessionId: "opencode" },
        serverInfo: { name: "opencode", version: "1.18.17" },
      };
      break;
    case "thread/start":
      result = await open(params, false);
      break;
    case "thread/resume":
      result = await open(params, true);
      break;
    case "collaborationMode/list":
      result = openCodeProxyCollaborationModes(activeModel);
      break;
    case "turn/start": {
      if (!session) throw new Error("OpenCode thread is not open");
      assertOpenCodeProxyCollaborationMode(params);
      const inputItems = Array.isArray(params.input)
        ? params.input.map(record)
        : [];
      const messageText = inputItems
        .map((entry) => text(entry.text))
        .filter(Boolean)
        .join("\n");
      const turn = await session.startTurn({
        message: { role: "user", text: messageText },
      });
      activeTurnId = turn.turnId;
      // OpenCode normally publishes session/turn startup over SSE, but a fast
      // completion can make the synchronous prompt response the only place the
      // authoritative turn id is observed. Emit the normalized notification
      // after this request's JSON-RPC response when SSE did not already announce
      // it. runnerd buffers notifications received while awaiting a response,
      // so replaying an earlier SSE announcement would violate strict turn
      // binding at the outer driver.
      queueMicrotask(() => {
        announceTurnStarted(session!, turn.turnId);
      });
      result = { turn: { id: turn.turnId, status: "inProgress" } };
      break;
    }
    case "turn/interrupt":
      if (!session?.interrupt)
        throw new Error("OpenCode interruption is unavailable");
      await session.interrupt({
        turnId: text(params.turnId, activeTurnId ?? ""),
      });
      result = true;
      break;
    case "thread/read":
      if (!session) throw new Error("OpenCode thread is not open");
      result = {
        thread: {
          id: session.ids().driverSessionId,
          cwd,
          turns: activeTurnId
            ? [{ id: activeTurnId, status: "inProgress" }]
            : [],
        },
        transcript: await session.read?.(),
      };
      break;
    default:
      throw new Error(`Unsupported OpenCode proxy method ${message.method}`);
  }
  send({ id: message.id, result });
}

let pendingInput = Promise.resolve();
let bootstrapFailure: Error | null = null;
input.on("line", (line) => {
  if (!line.trim()) return;
  let message: RpcMessage;
  try {
    message = JSON.parse(line) as RpcMessage;
  } catch (error) {
    process.stderr.write(`Invalid JSON-RPC input: ${String(error)}\n`);
    return;
  }
  pendingInput = enqueueOpenCodeProxyInput(
    pendingInput,
    async () => {
      if (bootstrapFailure) {
        throw new Error(
          `OpenCode provider bootstrap failed before ${message.method ?? "the dependent command"}: ${bootstrapFailure.message}`,
        );
      }
      await handle(message);
    },
    (error) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (
        message.method === "initialize" ||
        message.method === "thread/start" ||
        message.method === "thread/resume"
      ) {
        bootstrapFailure ??= normalized;
      }
      send({
        id: message.id,
        error: { code: -32000, message: normalized.message },
      });
    },
  );
});

let shutdownPromise: Promise<void> | null = null;
function failProxy(error: unknown): void {
  process.stderr.write(
    `[opencode] fatal proxy error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  void shutdown(1);
}

function shutdown(exitCode = 0): Promise<void> {
  shutdownPromise ??= (async () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("OpenCode proxy is shutting down"));
    pending.clear();
    await session
      ?.close({ reason: "proxy_shutdown", force: true })
      .catch(() => {});
    await eventPump?.catch(() => {});
  })().finally(() => process.exit(exitCode));
  return shutdownPromise;
}

input.on("close", () => {
  void pendingInput.then(() => shutdown());
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
