/**
 * Low-level HTTP client for the Paperclip API.
 * Keeps run ID header injection and error normalization in one place.
 */

export class PaperclipApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

export interface RawClientConfig {
  apiUrl: string;
  apiKey: string;
  runId?: string;
}

export class PaperclipRawClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly runId?: string;

  constructor(config: RawClientConfig) {
    this.base = config.apiUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.runId = config.runId;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.runId) {
      headers["X-Paperclip-Run-Id"] = this.runId;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let errorBody: unknown;
      try {
        errorBody = await res.json();
      } catch {
        errorBody = await res.text();
      }
      throw new PaperclipApiError(
        res.status,
        `Paperclip API ${method} ${path} → ${res.status}`,
        errorBody,
      );
    }

    return res.json() as Promise<T>;
  }
}
