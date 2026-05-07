import type { ToscaCredentials } from "./types.js";
import { ToscaApiError } from "./types.js";
import { resolveAuth } from "./auth.js";

export interface HttpClientOptions {
  baseUrl: string;
  credentials: ToscaCredentials;
  fetchFn?: typeof globalThis.fetch;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly credentials: ToscaCredentials;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    },
  ): Promise<T> {
    const auth = await resolveAuth(this.credentials, this.fetchFn);

    const url = new URL(this.baseUrl + path);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: auth.authorizationHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const response = await this.fetchFn(url.toString(), {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      let errorBody: { code: string; message: string; details?: Record<string, unknown> };
      try {
        errorBody = (await response.json()) as typeof errorBody;
      } catch {
        errorBody = {
          code: "UNKNOWN",
          message: `HTTP ${response.status} ${response.statusText}`,
        };
      }
      throw new ToscaApiError(response.status, errorBody);
    }

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return (await response.json()) as T;
  }

  get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  delete<T = void>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, { body });
  }
}
