import type { PaperclipMcpConfig } from "./config.js";
import { RequestContext } from "./context.js";

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

export class PaperclipApiClient {
  /**
   * The request-scoped actor identity behind this client. In --http mode a
   * fresh client (and thus a fresh context) is built per request from the
   * bearer-token binding; in --stdio mode it is derived once from the process
   * environment. Company/agent resolution and per-tool company-access
   * authorization funnel through it — see {@link RequestContext}.
   */
  readonly context: RequestContext;

  constructor(private readonly config: PaperclipMcpConfig) {
    this.context = RequestContext.fromConfig(config);
  }

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
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
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Paperclip-Run-Id"] = this.config.runId;
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
