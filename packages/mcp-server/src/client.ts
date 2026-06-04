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
   * Company the request targets. Sent as the `X-Paperclip-Company` header so
   * the API can scope the request explicitly. Already-resolved company UUID.
   */
  companyId?: string | null;
}

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

interface CompanyListEntry {
  id: string;
  issuePrefix?: string | null;
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
  private companyCache: Promise<CompanyListEntry[]> | null = null;

  constructor(private readonly config: PaperclipMcpConfig) {}

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
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
   *
   * Prefix resolution lists the companies the auth token is actually a member
   * of (GET /companies, board/user tokens only) and matches on `issuePrefix`.
   * This deliberately does NOT bypass authz: the server still rejects any
   * company the token cannot access, and prefixes that don't resolve to a
   * member company throw before any cross-company call is made.
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

  private listCompanies(): Promise<CompanyListEntry[]> {
    if (!this.companyCache) {
      this.companyCache = this.requestJson<CompanyListEntry[]>("GET", "/companies").catch((error) => {
        // Reset so a transient failure doesn't poison subsequent calls.
        this.companyCache = null;
        throw error;
      });
    }
    return this.companyCache;
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
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Paperclip-Run-Id"] = this.config.runId;
    }
    const companyOverride = options.companyId?.trim();
    if (companyOverride) {
      headers["X-Paperclip-Company"] = companyOverride;
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
