import { URL } from "node:url";

export class ApiRequestError extends Error {
  status: number;
  details?: unknown;
  body?: unknown;

  constructor(status: number, message: string, details?: unknown, body?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    this.body = body;
  }
}

interface RequestOptions {
  ignoreNotFound?: boolean;
}

interface ApiClientOptions {
  apiBase: string;
  apiKey?: string;
  runId?: string;
}

export class PaperclipApiClient {
  readonly apiBase: string;
  readonly apiKey?: string;
  readonly runId?: string;

  constructor(opts: ApiClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.runId = opts.runId?.trim() || undefined;
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, { method: "GET" }, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }, opts);
  }

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
    }, opts);
  }

  delete<T>(path: string, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, { method: "DELETE" }, opts);
  }

  private async request<T>(path: string, init: RequestInit, opts?: RequestOptions): Promise<T | null> {
    const url = buildUrl(this.apiBase, path);

    const headers: Record<string, string> = {
      accept: "application/json",
      ...toStringRecord(init.headers),
    };

    if (init.body !== undefined) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
    }

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    if (this.runId) {
      headers["x-paperclip-run-id"] = this.runId;
    }

    const response = await fetch(url, {
      ...init,
      headers,
    });

    if (opts?.ignoreNotFound && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await toApiError(response);
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text.trim()) {
      return null;
    }

    return safeParseJson(text) as T;
  }
}

function buildUrl(apiBase: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const [pathname, query] = normalizedPath.split("?");
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  if (query) url.search = query;
  return url.toString();
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toApiError(response: Response): Promise<ApiRequestError> {
  const text = await response.text();
  const parsed = safeParseJson(text);

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const body = parsed as Record<string, unknown>;
    const message =
      (typeof body.error === "string" && body.error.trim()) ||
      (typeof body.message === "string" && body.message.trim()) ||
      `Request failed with status ${response.status}`;

    return new ApiRequestError(response.status, message, body.details, parsed);
  }

  return new ApiRequestError(response.status, `Request failed with status ${response.status}`, undefined, parsed);
}

function toStringRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}
