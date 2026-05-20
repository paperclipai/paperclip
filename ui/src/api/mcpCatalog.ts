// LET-515 — typed MCP catalog read + safe-install preview client.
//
// Wraps the LET-515 server routes:
//   GET    /companies/:companyId/mcp-catalog
//   POST   /companies/:companyId/mcp-catalog/preview
//
// The preview endpoint is read-only and fail-closed. The client refuses raw
// secret values *client-side* before sending — so a paste in the picker is
// rejected before it ever reaches the network. The server enforces the same
// gate; this is defence in depth.
import type {
  McpInstallPreview,
  NormalizedMcpServerDefinition,
} from "@paperclipai/shared";

const BASE = "/api";

export const SECRET_REF_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const SECRET_REF_NAME_MAX_LENGTH = 120;
export const SECRET_REF_MAX_COUNT = 16;

export class McpCatalogApiError extends Error {
  status: number;
  code: string | null;
  details: Record<string, unknown> | null;
  constructor(message: string, status: number, code: string | null, details: Record<string, unknown> | null) {
    super(message);
    this.name = "McpCatalogApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parseErrorBody(res: Response): Promise<McpCatalogApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const message =
    (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error
      : `Request failed: ${res.status}`) ?? `Request failed: ${res.status}`;
  const details =
    body && typeof body === "object" && "details" in body && typeof (body as { details: unknown }).details === "object"
      ? ((body as { details: Record<string, unknown> }).details ?? null)
      : null;
  const code = details && typeof details.code === "string" ? details.code : null;
  return new McpCatalogApiError(message, res.status, code, details);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? undefined);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init, headers });
  if (!res.ok) throw await parseErrorBody(res);
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface McpCatalogListEntry {
  readonly catalogId: string;
  readonly server: NormalizedMcpServerDefinition;
  readonly preview: McpInstallPreview;
}

export interface McpCatalogListResponse {
  readonly entries: ReadonlyArray<McpCatalogListEntry>;
}

export interface McpCatalogPreviewResult {
  readonly catalogId: string;
  readonly server: NormalizedMcpServerDefinition;
  readonly preview: McpInstallPreview;
  readonly suppliedSecretRefs: ReadonlyArray<string>;
  readonly missingRequiredSecretRefs: ReadonlyArray<string>;
  readonly applyPath: "preview_only";
}

export function assertSecretRefName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new McpCatalogApiError(
      "Secret reference name must be a non-empty string",
      400,
      "MCP_CATALOG_INVALID_SECRET_REF",
      null,
    );
  }
  if (name.length > SECRET_REF_NAME_MAX_LENGTH) {
    throw new McpCatalogApiError(
      "Secret reference name is too long",
      400,
      "MCP_CATALOG_INVALID_SECRET_REF",
      null,
    );
  }
  if (!SECRET_REF_NAME_PATTERN.test(name)) {
    const looksLikeSecret =
      name.length >= 12 || /[^A-Za-z0-9_]/.test(name) || /[a-z]/.test(name);
    throw new McpCatalogApiError(
      looksLikeSecret
        ? "Picker rejected a value that looks like a raw secret. Use a named secret reference."
        : "Secret reference name does not match the env-style identifier contract",
      400,
      looksLikeSecret ? "MCP_CATALOG_RAW_SECRET_REJECTED" : "MCP_CATALOG_INVALID_SECRET_REF",
      null,
    );
  }
}

export const mcpCatalogApi = {
  list: (companyId: string) =>
    call<McpCatalogListResponse>(`/companies/${companyId}/mcp-catalog`),

  preview: (companyId: string, body: { catalogId: string; namedSecretRefs?: string[] }) => {
    for (const name of body.namedSecretRefs ?? []) {
      assertSecretRefName(name);
    }
    if ((body.namedSecretRefs ?? []).length > SECRET_REF_MAX_COUNT) {
      throw new McpCatalogApiError(
        "Too many secret references supplied",
        400,
        "MCP_CATALOG_INVALID_SECRET_REF",
        null,
      );
    }
    return call<McpCatalogPreviewResult>(
      `/companies/${companyId}/mcp-catalog/preview`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
};
