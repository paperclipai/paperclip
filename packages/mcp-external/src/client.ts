import type { PaperclipExternalConfig } from "./config.js";
import { currentBearer } from "./auth-context.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Human-readable issue identifiers carry a company prefix, e.g. `PEN-307`.
 * Returns the uppercased prefix (`PEN`) or null for bare UUIDs / unprefixed ids.
 */
export function issuePrefixFromIdentifier(issueId: string): string | null {
  const trimmed = issueId.trim();
  if (!trimmed || isUuid(trimmed)) return null;
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(trimmed);
  return match ? match[1].toUpperCase() : null;
}

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
  /** Query params appended to the URL. undefined/null/empty-string values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
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
   * Resolve the Authorization header value for this request. Precedence mirrors
   * the Python server's _headers for the tiers this server implements: inbound
   * per-request bearer > baked PAPERCLIP_API_KEY. (Python also has a third
   * session-token/Cookie tier; intentionally omitted — this config has no
   * session token.) Throws if neither exists.
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

  /**
   * Synchronous resolution for callers that already hold a company UUID (or
   * rely solely on the default). Does NOT resolve prefixes — use
   * {@link resolveCompany} for per-request overrides that may be a prefix.
   */
  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  /**
   * Resolve a per-request company override to a company UUID.
   *
   * Precedence: explicit `override` (UUID or issue-prefix like "PEN") →
   * `issueId` prefix (e.g. "PEN-307" → "PEN") → default PAPERCLIP_COMPANY_ID.
   * Prefix resolution lists the companies the auth token is a member of
   * (GET /companies) and matches on `issuePrefix`. It does not bypass authz.
   */
  async resolveCompany(input: { override?: string | null; issueId?: string | null } = {}): Promise<string> {
    const explicit = input.override?.trim();
    const derived = input.issueId ? issuePrefixFromIdentifier(input.issueId) : null;
    const requested = explicit || derived;
    if (!requested) {
      return this.resolveCompanyId();
    }
    if (isUuid(requested)) {
      return requested;
    }
    const prefix = requested.toUpperCase();
    const companies = await this.listCompanies();
    const match = companies.find(
      (company) => (company.issuePrefix ?? "").trim().toUpperCase() === prefix,
    );
    if (!match) {
      throw new Error(
        `No accessible company with prefix "${prefix}". The auth token must be a member of that company (board/user token required for cross-company access).`,
      );
    }
    return match.id;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }
    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
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
