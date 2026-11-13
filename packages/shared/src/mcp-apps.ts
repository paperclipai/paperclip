/**
 * MCP Apps (SEP-1865, spec 2026-01-26): interactive `ui://` views that an MCP
 * server attaches to a tool. Paperclip is the host: it keeps the tool's UI
 * declaration, records each call whose tool has one, and renders the view in a
 * sandboxed iframe in the task chat.
 *
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import { z } from "zod";

export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
/** Largest view document Paperclip renders. Larger documents fall back to the plain tool row. */
export const MCP_APP_MAX_HTML_BYTES = 4 * 1024 * 1024;

/** Client capability Paperclip advertises in `initialize` to MCP servers. */
export const MCP_APPS_CLIENT_CAPABILITY = {
  [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] },
} as const;

export type McpAppToolVisibility = "model" | "app";

/**
 * A tool's normalized `_meta.ui` declaration. `resourceUri` is null for a tool
 * that only declares visibility, such as an app-only helper without a view.
 */
export interface McpAppToolUi {
  resourceUri: string | null;
  visibility: McpAppToolVisibility[];
}

export interface McpAppResourceCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

export interface McpAppResourcePermissions {
  camera?: boolean;
  microphone?: boolean;
  geolocation?: boolean;
  clipboardWrite?: boolean;
}

/** The view document plus the resource's `_meta.ui` rendering hints. */
export interface McpAppResource {
  uri: string;
  html: string;
  csp: McpAppResourceCsp;
  permissions: McpAppResourcePermissions;
  prefersBorder: boolean | null;
}

/** One recorded tool call whose tool declares a view. */
export interface McpAppViewSummary {
  id: string;
  issueId: string | null;
  runId: string | null;
  connectionId: string;
  applicationName: string;
  /** Name the agent called (the gateway tool name). */
  toolName: string;
  /** The provider's own tool name. */
  upstreamToolName: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  createdAt: string;
}

export interface McpAppViewDetail extends McpAppViewSummary {
  /** The MCP `CallToolResult` sent to the view as `ui/notifications/tool-result`. */
  toolResult: McpAppCallToolResult;
  resource: McpAppResource;
}

export interface McpAppCallToolResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

/** Body of `POST /api/issues/:issueId/mcp-app-views/:viewId/tool-calls`: a view's `tools/call`. */
export const mcpAppToolCallSchema = z.object({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type McpAppToolCallRequest = z.infer<typeof mcpAppToolCallSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return list;
}

/**
 * Reads a tool's UI declaration from its `_meta`. Accepts the deprecated flat
 * `_meta["ui/resourceUri"]` key, which servers still emit during the
 * transition. Visibility is kept even without a view, so an app-only helper
 * stays hidden from agents. Returns null when the tool declares neither.
 */
export function readMcpAppToolUi(meta: unknown): McpAppToolUi | null {
  const metaRecord = record(meta);
  if (!metaRecord) return null;
  const ui = record(metaRecord.ui);
  const rawUri = typeof ui?.resourceUri === "string"
    ? ui.resourceUri
    : typeof metaRecord["ui/resourceUri"] === "string" ? metaRecord["ui/resourceUri"] as string : null;
  const resourceUri = rawUri && rawUri.startsWith("ui://") && rawUri.length <= 2048 ? rawUri : null;
  const declared = Array.isArray(ui?.visibility)
    ? (ui.visibility as unknown[]).filter((item): item is McpAppToolVisibility => item === "model" || item === "app")
    : null;
  if (!resourceUri && declared === null) return null;
  // An explicit list with no valid entries (for example `[]`) grants nothing.
  const visibility = declared === null ? ["model", "app"] as McpAppToolVisibility[] : [...new Set(declared)];
  return { resourceUri, visibility };
}

export function mcpAppToolVisibleToModel(ui: McpAppToolUi | null | undefined): boolean {
  return !ui || ui.visibility.includes("model");
}

export function mcpAppToolCallableFromApp(ui: McpAppToolUi | null | undefined): boolean {
  return !ui || ui.visibility.includes("app");
}

/**
 * Picks the view document out of a `resources/read` result. The content must be
 * the requested `ui://` resource with the MCP Apps mime type; `text` or base64
 * `blob` content is accepted.
 */
export function readMcpAppResource(result: unknown, uri: string): McpAppResource | null {
  const contents = record(result)?.contents;
  if (!Array.isArray(contents)) return null;
  for (const item of contents) {
    const content = record(item);
    if (!content) continue;
    if (typeof content.uri === "string" && content.uri !== uri) continue;
    const mimeType = typeof content.mimeType === "string" ? content.mimeType.replace(/\s+/g, "").toLowerCase() : "";
    if (mimeType !== MCP_APP_MIME_TYPE) continue;
    const html = typeof content.text === "string"
      ? content.text
      : typeof content.blob === "string" ? decodeBase64Utf8(content.blob) : null;
    if (html === null || html.length === 0) continue;
    const ui = record(record(content._meta)?.ui);
    const csp = record(ui?.csp);
    const permissions = record(ui?.permissions);
    return {
      uri,
      html,
      csp: {
        connectDomains: stringList(csp?.connectDomains),
        resourceDomains: stringList(csp?.resourceDomains),
        frameDomains: stringList(csp?.frameDomains),
        baseUriDomains: stringList(csp?.baseUriDomains),
      },
      permissions: {
        camera: permissions?.camera === true || record(permissions?.camera) !== null,
        microphone: permissions?.microphone === true || record(permissions?.microphone) !== null,
        geolocation: permissions?.geolocation === true || record(permissions?.geolocation) !== null,
        clipboardWrite: permissions?.clipboardWrite === true || record(permissions?.clipboardWrite) !== null,
      },
      prefersBorder: typeof ui?.prefersBorder === "boolean" ? ui.prefersBorder : null,
    };
  }
  return null;
}

function decodeBase64Utf8(value: string): string | null {
  try {
    const binary = globalThis.atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A CSP source is accepted only when it is an https origin (optionally with a
 * leading `*.` subdomain wildcard). Anything else (keywords, schemes, paths,
 * quotes) is dropped so a server cannot widen the policy beyond origins.
 */
export function sanitizeMcpAppCspSource(source: string): string | null {
  const trimmed = source.trim();
  const match = /^https:\/\/(\*\.)?([a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?\/?$/i.exec(trimmed);
  if (!match) return null;
  return `https://${match[1] ?? ""}${match[2]!.toLowerCase()}${match[4] ?? ""}`;
}

/**
 * The CSP for a view: the spec's restrictive default plus only the origins the
 * server declared in `_meta.ui.csp`.
 */
export function buildMcpAppCsp(csp: McpAppResourceCsp): string {
  const list = (values: string[] | undefined) => (values ?? []).map(sanitizeMcpAppCspSource).filter((value): value is string => value !== null);
  const resource = list(csp.resourceDomains);
  const connect = list(csp.connectDomains);
  const frame = list(csp.frameDomains);
  const base = list(csp.baseUriDomains);
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    `script-src ${join("'unsafe-inline'", ...resource)}`,
    `style-src ${join("'unsafe-inline'", ...resource)}`,
    `img-src ${join("data:", "blob:", ...resource)}`,
    `font-src ${join("data:", ...resource)}`,
    `media-src ${join("data:", "blob:", ...resource)}`,
    `connect-src ${connect.length > 0 ? connect.join(" ") : "'none'"}`,
    `frame-src ${frame.length > 0 ? frame.join(" ") : "'none'"}`,
    `base-uri ${base.length > 0 ? base.join(" ") : "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}
