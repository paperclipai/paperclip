import type { PaperclipExternalConfig } from "./config.js";
import { currentBearer } from "./auth-context.js";

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  constructor(input: { status: number; method: string; path: string; body: unknown; message: string }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export interface JsonRequestOptions {
  /** Request body. Omit (undefined) for no body; `null` is sent as JSON `null`. */
  body?: unknown;
  companyId?: string | null;
}

interface CompanyListEntry {
  id: string;
  issuePrefix?: string | null;
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof (body as any).error === "string") {
    return `${method} ${path} failed with ${status}: ${(body as any).error}`;
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
  /** Per-bearer company list cache: a tenant never sees another tenant's companies. */
  private companyCacheByBearer = new Map<string, Promise<CompanyListEntry[]>>();

  constructor(private readonly config: PaperclipExternalConfig) {}

  /**
   * Resolve the Authorization header value for this request.
   * Precedence mirrors the Python server (_headers): inbound per-request bearer
   * > baked fallback key. Throws if neither exists.
   */
  private authorization(): string {
    const inbound = currentBearer();
    if (inbound && inbound.trim()) return inbound.trim();
    if (this.config.apiKey) return `Bearer ${this.config.apiKey}`;
    throw new Error(
      "Unauthenticated: no inbound bearer on the request and PAPERCLIP_API_KEY is not set.",
    );
  }

  listCompanies(): Promise<CompanyListEntry[]> {
    const raw = currentBearer();
    const key = raw && raw.trim() ? raw.trim() : "__baked__";
    let cached = this.companyCacheByBearer.get(key);
    if (!cached) {
      cached = this.requestJson<CompanyListEntry[]>("GET", "/companies").catch((error) => {
        this.companyCacheByBearer.delete(key); // don't poison on transient failure
        throw error;
      });
      this.companyCacheByBearer.set(key, cached);
    }
    return cached;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }
    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: this.authorization(),
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const companyOverride = options.companyId?.trim();
    if (companyOverride) headers["X-Paperclip-Company"] = companyOverride;

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
