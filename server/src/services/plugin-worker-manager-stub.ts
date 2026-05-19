// Stub PluginWorkerManager for the API tier of the API/worker split.
//
// When PAPERCLIP_NODE_ROLE=api, the process does NOT spawn plugin worker
// subprocesses. Plugins with singleton external state (Slack websockets,
// OAuth refresh_tokens, gbrain MCP servers) can't safely run on multiple
// pods, so the workers tier (1 replica) is the only place pluginWorkerManager
// runs.
//
// Hot paths (GitHub webhooks, agent MCP calls via /api/*) don't call into
// pluginWorkerManager — they enqueue DB rows that the workers tier drains
// async via the heartbeat scheduler. The webhook handler passes
// `pluginWorkerManager` to `heartbeatService()` but `enqueueWakeup` itself
// doesn't reference it (verified via grep on 2026-05-19).
//
// Admin routes (routines, costs, approvals, environments, agent worker
// reset) DO call pluginWorkerManager directly. On the API tier those routes
// throw `not_available_on_api_tier` which propagates as 503 — operators
// should hit the workers tier directly (or wait for the JSON-RPC bridge in
// a follow-up PR).
//
// Read-only queries (`getWorker`, `isRunning`, `diagnostics`) return
// safe-empty values rather than throwing — this lets routes that just
// CHECK whether a plugin is loaded continue to work without 503s. They
// just see "no plugin worker running" and adapt.

import type {
  HostToWorkerMethodName,
  HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import type {
  PluginWorkerHandle,
  PluginWorkerManager,
  WorkerDiagnostics,
  WorkerStartOptions,
} from "./plugin-worker-manager.js";

class ApiTierPluginWorkerError extends Error {
  readonly statusCode = 503;
  readonly code = "not_available_on_api_tier";
  constructor(method: string) {
    super(
      `pluginWorkerManager.${method}() not available on the API tier (PAPERCLIP_NODE_ROLE=api). ` +
        `Plugin worker operations require the workers tier; either retry through the worker pod's ` +
        `internal Service or wait for the JSON-RPC bridge follow-up.`,
    );
    this.name = "ApiTierPluginWorkerError";
  }
}

export function createApiTierPluginWorkerManagerStub(): PluginWorkerManager {
  return {
    async startWorker(_pluginId: string, _options: WorkerStartOptions): Promise<PluginWorkerHandle> {
      throw new ApiTierPluginWorkerError("startWorker");
    },
    async stopWorker(_pluginId: string): Promise<void> {
      throw new ApiTierPluginWorkerError("stopWorker");
    },
    getWorker(_pluginId: string): PluginWorkerHandle | undefined {
      // Safe-empty: callers that branch on "is there a worker?" see "no"
      // and skip plugin RPC paths gracefully. This is the read-side
      // intentional softening; the throw lives on the actually-do-something
      // methods (startWorker, stopWorker).
      return undefined;
    },
    isRunning(_pluginId: string): boolean {
      return false;
    },
    async stopAll(): Promise<void> {
      // No-op: nothing to stop on the API tier.
    },
    diagnostics(): WorkerDiagnostics[] {
      return [];
    },
    async call<M extends HostToWorkerMethodName>(
      _pluginId: string,
      _method: M,
      _params: HostToWorkerMethods[M][0],
      _timeoutMs?: number,
    ): Promise<HostToWorkerMethods[M][1]> {
      throw new ApiTierPluginWorkerError("call");
    },
  };
}

export { ApiTierPluginWorkerError };
