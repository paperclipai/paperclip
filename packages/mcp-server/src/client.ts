import { AsyncLocalStorage } from "node:async_hooks";
import type { PaperclipMcpConfig } from "./config.js";

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
  /**
   * Run id for this call, overriding PAPERCLIP_RUN_ID.
   *
   * The env var is read once at startup, which is enough for a server spawned per
   * run but not for a long-lived or shared one — there the current run is simply
   * not knowable when the process starts. Without a run id the server omits
   * X-Paperclip-Run-Id, comments land with created_by_run_id NULL, and the guards
   * that recognise an agent's own comment (shouldImplicitlyMoveCommentedIssueToTodo,
   * deferredCommentWakeIsSelfAuthored) cannot fire — so a run that closes its issue
   * and comments reopens it and wakes itself.
   */
  runId?: string | null;
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Run id for the tool call currently executing.
 *
 * A shared client cannot hold this on the instance: tool calls interleave, and a
 * field would leak one call's run id into another. AsyncLocalStorage scopes it to
 * the call that set it.
 */
const runIdScope = new AsyncLocalStorage<string | undefined>();

/** Run `fn` with `runId` applied to every request it makes. */
export function withRunId<T>(runId: string | undefined, fn: () => T): T {
  return runIdScope.run(runId, fn);
}

export class PaperclipApiClient {
  constructor(private readonly config: PaperclipMcpConfig) {}

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
  }

  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because PAPERCLIP_AGENT_ID is not set");
    }
    return resolved;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const runId = options.runId?.trim() || runIdScope.getStore()?.trim() || this.config.runId;
    if ((options.includeRunId ?? isWriteMethod(method)) && runId) {
      headers["X-Paperclip-Run-Id"] = runId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      throw new PaperclipApiError({
        status: response.status,
        method: method.toUpperCase(),
        path,
        body: parsedBody,
        message: buildErrorMessage(method.toUpperCase(), path, response.status, parsedBody),
      });
    }

    return parsedBody as T;
  }
}
