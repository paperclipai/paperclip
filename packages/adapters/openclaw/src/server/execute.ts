import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseOpenClawAgentResult,
  isOpenClawError,
} from "./parse.js";
import {
  buildRpcRequest,
  isRpcResponse,
  openWebSocket,
  safeCloseWebSocket,
} from "./rpc.js";

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  // ---- extract config ----
  const gatewayUrl = asString(config.gatewayUrl, "ws://127.0.0.1:5555").trim();
  const agentId = asString(config.agentId, "").trim();
  const authToken = asString(config.authToken, "").trim();
  const timeoutSec = Math.max(1, asNumber(config.timeoutSec, 120));
  const model = asString(config.model, "unknown");

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  if (!agentId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw adapter missing agentId in config",
      errorCode: "openclaw_agent_id_missing",
    };
  }

  // ---- build message from prompt template ----
  const message = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });

  // ---- build RPC params ----
  const sessionKey = `agent:${agentId}:paperclip:${runId}`;
  const rpcParams: Record<string, unknown> = {
    message,
    agentId,
    sessionKey,
    idempotencyKey: runId,
    timeout: timeoutSec,
  };

  const extraSystemPrompt = asString(config.extraSystemPrompt, "").trim();
  if (extraSystemPrompt) {
    rpcParams.extraSystemPrompt = extraSystemPrompt;
  }
  const label = asString(config.label, "").trim();
  if (label) {
    rpcParams.label = label;
  }

  // ---- report invocation metadata ----
  if (onMeta) {
    await onMeta({
      adapterType: "openclaw",
      command: "websocket-rpc",
      cwd: undefined,
      commandArgs: [gatewayUrl, `agent:${agentId}`],
      prompt: message,
      context,
    });
  }

  // ---- connect to gateway ----
  await onLog("stdout", `[openclaw] connecting to gateway ${gatewayUrl}\n`);

  let ws: WebSocket;
  const wsHeaders: Record<string, string> = {};
  if (authToken) {
    wsHeaders.authorization = `Bearer ${authToken}`;
  }

  try {
    ws = await openWebSocket(gatewayUrl, wsHeaders);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[openclaw] gateway connection failed: ${errMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to connect to OpenClaw gateway at ${gatewayUrl}: ${errMsg}`,
      errorCode: "openclaw_connection_failed",
    };
  }

  await onLog("stdout", `[openclaw] connected to gateway\n`);

  // ---- send agent RPC and await two-phase response ----
  const { frame, id: requestId } = buildRpcRequest("agent", rpcParams);

  try {
    const result = await new Promise<AdapterExecutionResult>((resolve) => {
      let acceptedRunId: string | null = null;
      let settled = false;

      const settle = (res: AdapterExecutionResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      };

      // Timeout guard
      const timer = setTimeout(() => {
        void onLog(
          "stderr",
          `[openclaw] timed out after ${timeoutSec}s waiting for agent result\n`,
        );
        settle({
          exitCode: null,
          signal: null,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          errorCode: "timeout",
          provider: "openclaw",
          model,
        });
      }, timeoutSec * 1000);

      const onMessage = (ev: MessageEvent) => {
        let data: unknown;
        try {
          data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return; // skip non-JSON frames
        }

        if (!isRpcResponse(data)) return;
        if (data.id !== requestId) return;

        const payload = data.payload ?? {};

        // ---- Phase 1: accepted ----
        if (
          typeof payload.status === "string" &&
          payload.status === "accepted"
        ) {
          acceptedRunId =
            typeof payload.runId === "string" ? payload.runId : null;
          void onLog(
            "stdout",
            `[openclaw] agent run accepted${acceptedRunId ? ` (runId: ${acceptedRunId})` : ""}\n`,
          );
          return; // wait for Phase 2
        }

        // ---- Phase 2: final result ----
        const parsed = parseOpenClawAgentResult(payload);

        if (isOpenClawError(payload)) {
          void onLog(
            "stderr",
            `[openclaw] agent run error: ${parsed.error ?? "unknown error"}\n`,
          );
          settle({
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: parsed.error ?? "OpenClaw agent run failed",
            errorCode: "openclaw_agent_error",
            provider: "openclaw",
            model,
            summary: parsed.summary,
            resultJson: payload,
          });
          return;
        }

        // Success
        void onLog(
          "stdout",
          `[openclaw] agent run completed${parsed.summary ? `: ${parsed.summary.slice(0, 200)}` : ""}\n`,
        );
        settle({
          exitCode: 0,
          signal: null,
          timedOut: false,
          provider: "openclaw",
          model,
          summary: parsed.summary ?? `OpenClaw agent ${agentId} completed`,
          resultJson: payload,
        });
      };

      const onWsError = (ev: Event) => {
        const errMsg =
          (ev as ErrorEvent).message ?? "WebSocket error during agent run";
        void onLog("stderr", `[openclaw] websocket error: ${errMsg}\n`);
        settle({
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `WebSocket error: ${errMsg}`,
          errorCode: "openclaw_ws_error",
          provider: "openclaw",
          model,
        });
      };

      const onWsClose = () => {
        // If the connection drops before we get a final result, attempt
        // to report a clean error rather than hanging.
        void onLog(
          "stderr",
          "[openclaw] websocket closed before receiving final result\n",
        );
        settle({
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage:
            "WebSocket connection closed before agent run completed",
          errorCode: "openclaw_ws_closed",
          provider: "openclaw",
          model,
        });
      };

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("error", onWsError);
        ws.removeEventListener("close", onWsClose);
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onWsError);
      ws.addEventListener("close", onWsClose);

      // Send the RPC request
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        const sendErr = err instanceof Error ? err.message : String(err);
        void onLog("stderr", `[openclaw] failed to send RPC request: ${sendErr}\n`);
        settle({
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Failed to send RPC request: ${sendErr}`,
          errorCode: "openclaw_send_failed",
          provider: "openclaw",
          model,
        });
      }
    });

    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[openclaw] unexpected error: ${errMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errMsg,
      errorCode: "openclaw_unexpected_error",
      provider: "openclaw",
      model,
    };
  } finally {
    safeCloseWebSocket(ws);
  }
}
