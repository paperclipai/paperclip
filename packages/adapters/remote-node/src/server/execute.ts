import { EventEmitter } from "node:events";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_TIMEOUT_SEC = 3600;

// ---------------------------------------------------------------------------
// Remote run completion emitter
// ---------------------------------------------------------------------------

/** Module-level emitter for signalling remote run completion. */
export const remoteCompletionEmitter = new EventEmitter();
remoteCompletionEmitter.setMaxListeners(0);

export interface RemoteRunWaiter {
  resolve: (result: AdapterExecutionResult) => void;
  reject: (error: Error) => void;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

/**
 * Map of runId → waiter. Used by:
 * - execute() to register and await completion
 * - Report endpoint to resolve the waiter
 * - Cancel flow to reject the waiter
 */
export const remoteRunWaiters = new Map<string, RemoteRunWaiter>();

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, onLog, onMeta } = ctx;
  const config = parseObject(ctx.config);
  const nodeId = asString(config.nodeId, "");
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);

  if (!nodeId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "remote_node adapter requires nodeId in adapterConfig",
      errorCode: "missing_node_id",
    };
  }

  // Report invocation metadata
  if (onMeta) {
    await onMeta({
      adapterType: "remote_node",
      command: "remote_node",
      commandNotes: [
        `Waiting for remote node ${nodeId} to claim and execute run ${runId}`,
        `Timeout: ${timeoutSec}s`,
      ],
    });
  }

  await onLog("stdout", JSON.stringify({
    type: "system",
    message: `Waiting for remote node to claim run (nodeId=${nodeId}, timeout=${timeoutSec}s)`,
  }) + "\n");

  // Create a deferred promise that the report endpoint will resolve
  const result = await new Promise<AdapterExecutionResult>((resolve, reject) => {
    const waiter: RemoteRunWaiter = { resolve, reject, onLog };
    remoteRunWaiters.set(runId, waiter);

    // Timeout handler
    const timer = setTimeout(() => {
      remoteRunWaiters.delete(runId);
      resolve({
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Remote node did not complete within ${timeoutSec}s`,
        errorCode: "remote_timeout",
      });
    }, timeoutSec * 1000);

    // Listen for completion event as backup notification path
    const onComplete = (data: { runId: string; result: AdapterExecutionResult }) => {
      if (data.runId !== runId) return;
      clearTimeout(timer);
      remoteRunWaiters.delete(runId);
      remoteCompletionEmitter.off("run.complete", onComplete);
      resolve(data.result);
    };
    remoteCompletionEmitter.on("run.complete", onComplete);

    // Also handle cancellation
    const onCancel = (data: { runId: string }) => {
      if (data.runId !== runId) return;
      clearTimeout(timer);
      remoteRunWaiters.delete(runId);
      remoteCompletionEmitter.off("run.cancel", onCancel);
      remoteCompletionEmitter.off("run.complete", onComplete);
      resolve({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        errorMessage: "Run cancelled",
        errorCode: "cancelled",
      });
    };
    remoteCompletionEmitter.on("run.cancel", onCancel);
  });

  return result;
}
