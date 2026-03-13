import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcChannel } from "@paperclipai/plugin-sdk";
import { RPC_TIMEOUTS } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");

export interface PluginWorkerEntry {
  pluginId: string;
  process: ChildProcess;
  rpc: RpcChannel;
  status: "starting" | "ready" | "error" | "stopping";
  restartCount: number;
  lastRestartAt?: Date;
}

interface SpawnOptions {
  initTimeoutMs?: number;
}

interface InitializeParams {
  pluginId: string;
  manifest: Record<string, unknown>;
  config: Record<string, unknown>;
}

export class ProcessManager {
  private workers = new Map<string, PluginWorkerEntry>();
  private requestHandler?: (
    pluginId: string,
    method: string,
    params: unknown,
    id: number | string,
  ) => Promise<unknown>;

  /**
   * Set handler for worker->host SDK calls.
   * Called by the SDK proxy.
   */
  setRequestHandler(
    handler: (pluginId: string, method: string, params: unknown, id: number | string) => Promise<unknown>,
  ) {
    this.requestHandler = handler;
  }

  /**
   * Spawn a plugin worker process and send initialize.
   */
  async spawn(
    pluginId: string,
    workerEntrypoint: string,
    initParams: InitializeParams,
    opts?: SpawnOptions,
  ): Promise<void> {
    const child = spawn(tsxBin, [workerEntrypoint], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Capture stderr for logging
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      console.log(`[plugin:${pluginId}:stderr] ${chunk.trimEnd()}`);
    });

    const rpc = new RpcChannel(child.stdout!, child.stdin!);

    // Route worker->host calls through the SDK proxy handler
    rpc.setRequestHandler(async (method, params, id) => {
      if (!this.requestHandler) {
        throw new Error("no SDK proxy handler registered");
      }
      return this.requestHandler(pluginId, method, params, id);
    });

    const entry: PluginWorkerEntry = {
      pluginId,
      process: child,
      rpc,
      status: "starting",
      restartCount: 0,
    };
    this.workers.set(pluginId, entry);

    // Handle unexpected exit
    child.on("exit", (code, signal) => {
      const current = this.workers.get(pluginId);
      if (current && current.status !== "stopping") {
        console.warn(`[plugins] worker ${pluginId} exited unexpectedly (code=${code}, signal=${signal})`);
        current.status = "error";
        rpc.destroy();
      }
    });

    // Send initialize
    const timeout = opts?.initTimeoutMs ?? RPC_TIMEOUTS.initialize;
    try {
      await rpc.call("initialize", initParams, timeout);
      entry.status = "ready";
    } catch (err) {
      entry.status = "error";
      rpc.destroy();
      child.kill("SIGKILL");
      this.workers.delete(pluginId);
      throw new Error(
        `Plugin ${pluginId} failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Get a worker entry by plugin ID.
   */
  get(pluginId: string): PluginWorkerEntry | undefined {
    return this.workers.get(pluginId);
  }

  /**
   * Send an RPC call to a specific worker.
   */
  async call(pluginId: string, method: string, params?: unknown): Promise<unknown> {
    const entry = this.workers.get(pluginId);
    if (!entry || entry.status !== "ready") {
      throw new Error(`Plugin ${pluginId} is not ready (status: ${entry?.status ?? "not found"})`);
    }
    const timeout = RPC_TIMEOUTS[method] ?? 30_000;
    return entry.rpc.call(method, params, timeout);
  }

  /**
   * Gracefully shut down a single worker.
   */
  async shutdown(pluginId: string): Promise<void> {
    const entry = this.workers.get(pluginId);
    if (!entry) return;

    entry.status = "stopping";

    try {
      await entry.rpc.call("shutdown", {}, RPC_TIMEOUTS.shutdown);
    } catch {
      // Timeout or error — force kill
    }

    entry.rpc.destroy();

    // Give the process time to exit, then force
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        entry.process.kill("SIGKILL");
        resolve();
      }, 5000);
      entry.process.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (entry.process.exitCode !== null) {
        clearTimeout(timer);
        resolve();
      }
    });

    this.workers.delete(pluginId);
  }

  /**
   * Shut down all workers.
   */
  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.workers.keys());
    await Promise.allSettled(ids.map((id) => this.shutdown(id)));
  }

  /**
   * List all worker plugin IDs.
   */
  list(): string[] {
    return Array.from(this.workers.keys());
  }

  /**
   * Check if a worker is ready.
   */
  isReady(pluginId: string): boolean {
    return this.workers.get(pluginId)?.status === "ready";
  }
}
