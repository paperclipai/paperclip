import { setTimeout as delay } from "node:timers/promises";
import type { CreateosConfig } from "./config.js";
import { resolveApiKey } from "./config.js";
import { waitForRequest } from "./request-pacer.js";

export class CreateosApiError extends Error {
  constructor(readonly status: number, operation?: string) {
    // Provider bodies may echo command input or credentials. Keep them out of
    // persisted errors and probe metadata.
    super(`CreateOS request failed (HTTP ${status})${operation ? ` during ${operation}` : ""}.`);
  }
}

export interface Sandbox {
  id: string;
  status?: string;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CreateOS returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new Error("CreateOS returned an invalid resource ID.");
  }
  return value;
}

export class CreateosClient {
  readonly apiKey: string;
  constructor(readonly config: CreateosConfig) {
    this.apiKey = resolveApiKey(config);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? AbortSignal.timeout(this.config.timeoutMs);
    await waitForRequest(this.config.apiUrl, signal);
    let response: Response;
    try {
      response = await fetch(`${this.config.apiUrl}/v1${path}`, {
        ...init,
        redirect: "error",
        headers: { ...init.headers, "X-Api-Key": this.apiKey },
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      // Do not propagate fetch causes: they can contain the configured URL.
      if (error instanceof Error && error.name === "TimeoutError") throw error;
      throw new Error("CreateOS connection failed.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Only fixed operation labels: never include paths, queries, or bodies,
      // which may contain credentials or private workspace names.
      const operation = path.includes("/files?") ? "file transfer"
        : path.includes("/stdin/close") ? "stdin close"
        : path.includes("/connect?") ? "output connection"
        : path.endsWith("/processes") ? "process creation"
        : path.includes("/processes/") ? "process cleanup"
        : path.endsWith("/exec") ? "workspace command"
        : "sandbox lifecycle";
      throw new CreateosApiError(response.status, operation);
    }
    return response;
  }

  async json(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
      signal,
    });
    let envelope: Record<string, unknown>;
    try { envelope = object(await response.json()); } catch { throw new Error("CreateOS returned invalid JSON."); }
    if (envelope.status !== "success") throw new Error("CreateOS returned an unsuccessful response.");
    return object(envelope.data);
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<Sandbox> {
    const data = await this.json(`/sandboxes/${identifier(id)}`, "GET", undefined, signal);
    if (data.id !== id || typeof data.status !== "string") throw new Error("CreateOS sandbox identity or state is invalid.");
    return { id, status: data.status };
  }

  async createSandbox(signal: AbortSignal): Promise<Sandbox> {
    const { shape, rootfs, region } = this.config;
    const data = await this.json("/sandboxes", "POST", {
      shape,
      ...(rootfs ? { rootfs } : {}),
      ...(region ? { region } : {}),
      ingress_enabled: false,
      // The host owns lease release. Idle pause is not a command timeout or a
      // guaranteed expiry, and could suspend a quiet active agent.
    }, signal);
    return { id: identifier(data.id) };
  }

  async destroySandbox(id: string): Promise<void> {
    try { await this.json(`/sandboxes/${identifier(id)}`, "DELETE"); }
    catch (error) { if (!(error instanceof CreateosApiError && error.status === 404)) throw error; }
  }

  async transition(id: string, desired: "running" | "paused", signal: AbortSignal): Promise<void> {
    let submitted = false;
    for (;;) {
      signal.throwIfAborted();
      const sandbox = await this.getSandbox(id, signal);
      if (sandbox.status === desired) return;
      const canSubmit = desired === "running"
        ? ["paused", "error"].includes(sandbox.status!)
        : sandbox.status === "running";
      if (canSubmit && !submitted) {
        try {
          await this.json(`/sandboxes/${id}/${desired === "running" ? "resume" : "pause"}`, "POST", undefined, signal);
          submitted = true;
        } catch (error) {
          // A concurrent state transition is reconciled by reading its state.
          if (!(error instanceof CreateosApiError && error.status === 409)) throw error;
        }
      } else if (!["creating", "pausing", "resuming"].includes(sandbox.status!)) {
        throw new Error(`CreateOS sandbox did not reach ${desired}.`);
      }
      await delay(250, undefined, { signal });
    }
  }

  async upload(id: string, path: string, content: string, signal: AbortSignal): Promise<void> {
    const response = await this.request(`/sandboxes/${identifier(id)}/files?path=${encodeURIComponent(path)}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: content, signal,
    });
    await response.body?.cancel();
  }
}
