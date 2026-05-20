// LET-515 — canonical MCP catalog read + safe-install preview service.
//
// Surface contract:
//   - `listCatalog()` returns the canonical, allowlisted MCP entries that the
//     EAOS onboarding picker (and the broader `/eaos/capabilities` registry)
//     can offer as install candidates. Every entry uses the `verified/` prefix
//     so it passes the existing `DefaultCatalogAllowlist`.
//   - `previewInstall({ catalogId, namedSecretRefs })` re-runs the same guards
//     the live capability-apply adapter would: catalog allowlist, SSRF egress
//     check on the remote URL, and a value-blind validation that the inputs
//     are named secret references (env-style identifiers), never raw secrets.
//     The function returns the canonical `McpInstallPreview` shape — it does
//     NOT mutate any agent config, does NOT contact the MCP, does NOT persist
//     anything. The result is a UI hint that the picker can render before the
//     real apply flow (per-agent capability-apply plan) is invoked.
//
// Safety:
//   - The catalog is hard-coded in-process. A future slice can swap this for
//     a DB- or DTS-backed catalog; the contract is the read shape, not the
//     storage. Keeping it in-process for now also avoids the dynamic-fetch
//     surface that an external catalog would introduce.
//   - No raw secret values appear in this module, its tests, its logs, or its
//     return values. Only NAMES (env-style identifiers) are accepted, and the
//     value-shape validation is here, before the request ever reaches the
//     adapter.

import {
  CAPABILITY_APPLY_ERROR_CODES,
  buildMcpInstallPreview,
  mcpCatalogEntrySchema,
  normalizeMcpCatalogEntry,
  type McpCatalogEntry,
  type McpCatalogEntryInput,
  type McpInstallPreview,
  type NormalizedMcpServerDefinition,
} from "@paperclipai/shared";
import {
  DefaultCatalogAllowlist,
  assertEgressAllowed,
  CapabilityApplyAdapterError,
  type CatalogAllowlist,
} from "./capability-apply-mcp-adapter.js";

const SECRET_REF_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_SECRET_REFS = 16;

const CANONICAL_ENTRIES: ReadonlyArray<McpCatalogEntryInput> = [
  {
    provider: "official_registry",
    id: "verified/paperclip-kernel",
    name: "Paperclip Kernel",
    title: "Paperclip Kernel (read-only)",
    description:
      "Canonical Paperclip kernel surface. Read-only by default; write actions remain board-approval gated.",
    transport: "stdio",
    sourceUrl: "https://github.com/paperclipai/paperclip",
    license: "Apache-2.0",
    requiredEnv: [],
    tools: [
      { name: "paperclip.list_issues", description: "List issues in scope." },
      { name: "paperclip.get_issue", description: "Read a single issue." },
    ],
    trust: { verifiedPublisher: true, sourceAvailable: true, containerized: true },
  },
  {
    provider: "official_registry",
    id: "verified/filesystem-readonly",
    name: "Filesystem (read-only)",
    title: "Filesystem (read-only)",
    description:
      "Read-only filesystem surface for the agent. No writes; no network. Useful for inspection-only flows.",
    transport: "stdio",
    sourceUrl: "https://github.com/modelcontextprotocol/servers",
    license: "MIT",
    requiredEnv: [],
    tools: [
      { name: "fs.read_file", description: "Read a single file." },
      { name: "fs.list_dir", description: "List a directory." },
    ],
    trust: { verifiedPublisher: true, sourceAvailable: true, containerized: false },
  },
  {
    provider: "official_registry",
    id: "verified/github-readonly",
    name: "GitHub (read-only)",
    title: "GitHub (read-only)",
    description:
      "Read-only GitHub surface. Requires a named GitHub token reference; the picker never accepts a raw token.",
    transport: "stdio",
    sourceUrl: "https://github.com/modelcontextprotocol/servers",
    license: "MIT",
    requiredEnv: [
      { name: "GITHUB_TOKEN", required: true, description: "Read scopes only." },
    ],
    tools: [
      { name: "github.get_repo", description: "Read repository metadata." },
      { name: "github.list_issues", description: "List issues for a repo." },
    ],
    trust: { verifiedPublisher: true, sourceAvailable: true, containerized: false },
  },
];

export interface McpCatalogListEntry {
  readonly catalogId: string;
  readonly server: NormalizedMcpServerDefinition;
  readonly preview: McpInstallPreview;
}

export interface McpCatalogPreviewInput {
  readonly catalogId: string;
  readonly namedSecretRefs?: ReadonlyArray<string>;
}

export interface McpCatalogPreviewResult {
  readonly catalogId: string;
  readonly server: NormalizedMcpServerDefinition;
  readonly preview: McpInstallPreview;
  readonly suppliedSecretRefs: ReadonlyArray<string>;
  readonly missingRequiredSecretRefs: ReadonlyArray<string>;
  readonly applyPath: "preview_only";
}

export type McpCatalogErrorCode =
  | typeof CAPABILITY_APPLY_ERROR_CODES.CATALOG_NOT_ALLOWLISTED
  | typeof CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED
  | typeof CAPABILITY_APPLY_ERROR_CODES.NAMED_SECRET_NOT_FOUND
  | "MCP_CATALOG_NOT_FOUND"
  | "MCP_CATALOG_RAW_SECRET_REJECTED"
  | "MCP_CATALOG_INVALID_SECRET_REF";

export class McpCatalogError extends Error {
  readonly code: McpCatalogErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: McpCatalogErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface McpCatalogServiceOptions {
  entries?: ReadonlyArray<McpCatalogEntryInput>;
  allowlist?: CatalogAllowlist;
}

export interface McpCatalogService {
  listCatalog(): McpCatalogListEntry[];
  previewInstall(input: McpCatalogPreviewInput): McpCatalogPreviewResult;
}

export function mcpCatalogService(opts: McpCatalogServiceOptions = {}): McpCatalogService {
  const allowlist = opts.allowlist ?? new DefaultCatalogAllowlist();
  const entries: McpCatalogEntry[] = (opts.entries ?? CANONICAL_ENTRIES).map((raw) =>
    mcpCatalogEntrySchema.parse(raw),
  );
  const allowed = entries.filter((entry) => allowlist.isAllowed(entry.id));
  const byId = new Map<string, McpCatalogEntry>(allowed.map((entry) => [entry.id, entry]));

  function buildEntryPreview(entry: McpCatalogEntry): { server: NormalizedMcpServerDefinition; preview: McpInstallPreview } {
    const server = normalizeMcpCatalogEntry(entry);
    if (entry.transport !== "stdio" && entry.remoteUrl) {
      try {
        assertEgressAllowed(entry.remoteUrl, `catalog[${entry.id}].remoteUrl`);
      } catch (err) {
        if (err instanceof CapabilityApplyAdapterError) {
          throw new McpCatalogError(
            CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED as McpCatalogErrorCode,
            err.message,
            { catalogId: entry.id, ...err.details },
          );
        }
        throw err;
      }
    }
    const preview = buildMcpInstallPreview(server);
    return { server, preview };
  }

  return {
    listCatalog() {
      return allowed.map((entry) => {
        const { server, preview } = buildEntryPreview(entry);
        return { catalogId: entry.id, server, preview };
      });
    },
    previewInstall(input: McpCatalogPreviewInput): McpCatalogPreviewResult {
      const catalogId = input.catalogId;
      if (!catalogId) {
        throw new McpCatalogError("MCP_CATALOG_NOT_FOUND", "catalogId is required", { catalogId });
      }
      if (!allowlist.isAllowed(catalogId)) {
        throw new McpCatalogError(
          CAPABILITY_APPLY_ERROR_CODES.CATALOG_NOT_ALLOWLISTED as McpCatalogErrorCode,
          "Catalog id is not on the verified allowlist",
          { catalogId },
        );
      }
      const entry = byId.get(catalogId);
      if (!entry) {
        throw new McpCatalogError("MCP_CATALOG_NOT_FOUND", "Catalog entry not found", { catalogId });
      }

      const supplied = (input.namedSecretRefs ?? []).map((name) => name);
      if (supplied.length > MAX_SECRET_REFS) {
        throw new McpCatalogError(
          "MCP_CATALOG_INVALID_SECRET_REF",
          "Too many secret references supplied",
          { catalogId, supplied: supplied.length, max: MAX_SECRET_REFS },
        );
      }
      for (const name of supplied) {
        if (typeof name !== "string" || name.length === 0) {
          throw new McpCatalogError(
            "MCP_CATALOG_INVALID_SECRET_REF",
            "Secret reference name must be a non-empty string",
            { catalogId },
          );
        }
        if (!SECRET_REF_NAME.test(name)) {
          const looksLikeSecret =
            name.length >= 12 || /[^A-Za-z0-9_]/.test(name) || /[a-z]/.test(name);
          throw new McpCatalogError(
            looksLikeSecret
              ? "MCP_CATALOG_RAW_SECRET_REJECTED"
              : "MCP_CATALOG_INVALID_SECRET_REF",
            looksLikeSecret
              ? "Picker rejected a value that looks like a raw secret. Use a named secret reference."
              : "Secret reference name does not match the env-style identifier contract",
            { catalogId },
          );
        }
      }

      const suppliedSet = new Set(supplied);
      const missingRequiredSecretRefs = entry.requiredEnv
        .filter((item) => item.required && !suppliedSet.has(item.name))
        .map((item) => item.name);

      const { server, preview } = buildEntryPreview(entry);

      return {
        catalogId,
        server,
        preview,
        suppliedSecretRefs: supplied,
        missingRequiredSecretRefs,
        applyPath: "preview_only",
      };
    },
  };
}

export const __TESTING__ = { CANONICAL_ENTRIES, SECRET_REF_NAME, MAX_SECRET_REFS };
