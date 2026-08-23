import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { WebSocket } from "ws";

type Frame = { type?: unknown; runId?: unknown; agentId?: unknown; kind?: unknown; message?: unknown; accepted?: unknown; error?: unknown };
const terminal = new Set(["completed", "failed", "cancelled"]);

function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function brief(context: Record<string, unknown>): string {
  const task = asRecord(context.task);
  const title = text(task.title) ?? text(context.title) ?? "Paperclip task";
  const description = text(task.description) ?? text(context.description) ?? "";
  return description ? `${title}\n\n${description}` : title;
}
function config(context: AdapterExecutionContext): { url: string; token: string; timeoutMs: number } | Error {
  const url = text(context.config.url);
  const token = text(context.config.authToken);
  if (!url || !token) return new Error("FirstMate Gateway requires url and authToken.");
  let parsed: URL;
  try { parsed = new URL(url); } catch { return new Error("FirstMate Gateway URL is invalid."); }
  if (parsed.protocol !== "wss:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return new Error("FirstMate Gateway must use wss:// outside local tests.");
  const seconds = typeof context.config.timeoutSec === "number" ? context.config.timeoutSec : Number(context.config.timeoutSec ?? 1800);
  return { url, token, timeoutMs: Math.max(1_000, Math.min(7_200_000, (Number.isFinite(seconds) ? seconds : 1800) * 1000)) };
}

export async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const settings = config(context);
  if (settings instanceof Error) return { exitCode: 1, signal: null, timedOut: false, errorMessage: settings.message, errorCode: "FIRSTMATE_CONFIG" };
  return new Promise((resolve) => {
    let settled = false;
    let acknowledged = false;
    const finish = (result: AdapterExecutionResult) => { if (!settled) { settled = true; clearTimeout(timer); socket.close(); resolve(result); } };
    const socket = new WebSocket(settings.url, { headers: { authorization: `Bearer ${settings.token}` } });
    const timer = setTimeout(() => finish({ exitCode: 1, signal: null, timedOut: true, errorMessage: "FirstMate run timed out.", errorCode: "FIRSTMATE_TIMEOUT" }), settings.timeoutMs);
    socket.on("error", () => finish({ exitCode: 1, signal: null, timedOut: false, errorMessage: "Could not reach FirstMate Gateway.", errorCode: "FIRSTMATE_UNREACHABLE" }));
    socket.on("message", async (raw) => {
      let frame: Frame; try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type === "hello") {
        const taskId = text(asRecord(context.context.task).id) ?? `heartbeat:${context.runId}`;
        socket.send(JSON.stringify({ type: "paperclip.dispatch", runId: context.runId, agentId: context.agent.id, taskId, brief: brief(context.context), idempotencyKey: `paperclip:${context.runId}` }));
        return;
      }
      if (frame.type === "paperclip.dispatch_ack" && frame.runId === context.runId) {
        if (frame.accepted === true) { acknowledged = true; await context.onLog("stdout", "FirstMate accepted Paperclip run.\n"); return; }
        const reason = text(frame.error);
        finish({ exitCode: 1, signal: null, timedOut: false, errorMessage: reason ? `FirstMate Gateway rejected the run: ${reason}.` : "FirstMate Gateway rejected the run.", errorCode: "FIRSTMATE_REJECTED" });
        return;
      }
      if (frame.type !== "paperclip.run_event" || frame.runId !== context.runId || frame.agentId !== context.agent.id || typeof frame.kind !== "string" || !terminal.has(frame.kind)) return;
      const message = text(frame.message) ?? `FirstMate ${frame.kind}.`;
      await context.onLog(frame.kind === "completed" ? "stdout" : "stderr", `${message}\n`);
      finish({ exitCode: frame.kind === "completed" ? 0 : 1, signal: null, timedOut: false, summary: message, errorMessage: frame.kind === "completed" ? null : message, errorCode: frame.kind === "completed" ? null : `FIRSTMATE_${frame.kind.toUpperCase()}` });
    });
    socket.on("close", () => { if (!settled) finish({ exitCode: 1, signal: null, timedOut: false, errorMessage: acknowledged ? "FirstMate Gateway closed before a terminal lifecycle event." : "FirstMate Gateway closed before dispatch acknowledgement.", errorCode: "FIRSTMATE_DISCONNECTED" }); });
  });
}
