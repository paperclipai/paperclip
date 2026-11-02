import { nativeProviderCatalogFor } from "../../native-provider-catalogs.js";
import { restConnectorFor } from "../../connectors/rest-registry.js";
import { googleWorkspaceToolTarget } from "@paperclipai/shared";
import { BROWSER_USE_TOOLS } from "@paperclipai/shared";
import { isMemoryConnectorId } from "@paperclipai/shared";
import { toolConnections } from "@paperclipai/db";
import type { ToolRiskLevel } from "@paperclipai/shared";
import { GOOGLE_WORKSPACE_CONNECTOR_PROFILES, type GoogleWorkspaceConnectorProfileId } from "@paperclipai/shared";
import { connectorToolPolicy } from "../../connectors/tool-policy.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export type McpToolDescriptor = {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export function normalizeToolDescriptor(tool: unknown): McpToolDescriptor | null {
  const record = asRecord(tool);
  if (typeof record.name !== "string" || record.name.trim().length === 0)
    return null;
  return {
    name: record.name.trim(),
    title: typeof record.title === "string" ? record.title : null,
    description:
      typeof record.description === "string" ? record.description : null,
    inputSchema: asRecord(record.inputSchema ?? record.input_schema),
    annotations: asRecord(record.annotations),
  };
}

// Match a verb anywhere it forms a name segment, not just at the leading edge.
// Real MCP servers namespace and style tool names many ways:
//   "github:create_issue", "notion:update_page", "slack:postMessage", "set_value".
// A leading-anchor regex (/^(create|...)/) misses every namespaced/camelCase
// form and silently classifies writes as read-only. We normalise camelCase to
// snake_case first so "postMessage" -> "post_message", then match the verb when
// it is delimiter- or word-bounded. This mirrors the gateway classifier in
// tool-gateway.ts (inferToolRisk) so the two stay consistent.
function verbMatches(toolName: string, verbs: string): boolean {
  const normalized = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return new RegExp(`\\b(${verbs})\\b|(^|[:._-])(${verbs})([:._-]|$)`).test(
    normalized,
  );
}

const NOTION_READ_TOOLS = new Set([
  "notion-fetch",
  "notion-get-async-task",
  "notion-get-comments",
  "notion-get-teams",
  "notion-get-users",
  "notion-query-data-sources",
  "notion-query-database-view",
  "notion-query-meeting-notes",
  "notion-search",
]);

const NOTION_WRITE_TOOLS = new Set([
  "notion-convert-page-to-skill",
  "notion-create-comment",
  "notion-create-database",
  "notion-create-folder",
  "notion-create-pages",
  "notion-create-view",
  "notion-duplicate-page",
  "notion-move-pages",
  "notion-update-data-source",
  "notion-update-page",
  "notion-update-view",
]);

const SHOPIFY_DESTRUCTIVE_TOOLS = new Set([
  "cancel-cart",
  "cancel-checkout",
  "complete-checkout",
]);

function normalizedProviderToolName(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[:._-]+/g, "-");
}

// Aggregators can add arbitrarily powerful tools without changing their MCP
// endpoint. Only these reviewed, exact capabilities are read-only. Unknown or
// renamed actions remain enabled by the usual access rules, but have write risk.
const AGGREGATOR_READ_TOOLS = new Map<string, ReadonlySet<string>>([
  ["executor", new Set(["skills"])],
  ["composio", new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_SEARCH_SKILLS", "COMPOSIO_USE_SKILL"])],
  ["arcade", new Set(["Github.GetRepository"])],
  ["zapier", new Set()],
]);

export function classifyRisk(
  tool: McpToolDescriptor,
  sourceTemplateKey?: string | null,
): ToolRiskLevel {
  if (sourceTemplateKey === "google-workspace") {
    const target = googleWorkspaceToolTarget(tool.name);
    if (!target) return "destructive";
    const risk = classifyRisk({ ...tool, name: target.upstreamName }, target.appSlug);
    if (risk === "destructive" || target.leaf === "delete_event" || target.leaf === "send_message") return "destructive";
    if (target.write) return "write";
    return risk;
  }
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true || annotations.destructive === true)
    return "destructive";
  const reviewedRisk = connectorToolPolicy(sourceTemplateKey).classifyRisk?.(tool);
  if (reviewedRisk) return reviewedRisk;
  const normalizedToolName = normalizedProviderToolName(tool.name);
  if (isMemoryConnectorId(sourceTemplateKey)) {
    if (verbMatches(tool.name, "delete|remove|destroy|forget|prune|reset")) return "destructive";
    // Supermemory uses one add_memory tool for both save and forget.
    if (sourceTemplateKey === "supermemory" && normalizedToolName === "add-memory") return "destructive";
    if (verbMatches(tool.name, "add|remember|save|record|ingest|cognify|update|create|set|upload|select|rename|share")) return "write";
    if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
    const reads = ["get", "list", "search", "recall", "query", "retrieve", "who"];
    return verbMatches(tool.name, reads.join("|")) ? "read" : "write";
  }
  const reviewedReads = AGGREGATOR_READ_TOOLS.get(sourceTemplateKey ?? "");
  if (reviewedReads) {
    if (verbMatches(tool.name, "delete|remove|destroy|unpublish")) return "destructive";
    if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
    return reviewedReads.has(tool.name) ? "read" : "write";
  }
  if (sourceTemplateKey === "browser-use-cloud") {
    return BROWSER_USE_TOOLS.find(t => t.name === tool.name)?.annotations.readOnlyHint ? "read" : "destructive";
  }
  // Fireflies sharing, moving, and access revocation are mutations even when
  // a provider omits annotations or mistakenly advertises a read hint.
  if (sourceTemplateKey === "fireflies" && [
    "fireflies-share-meeting", "fireflies-revoke-meeting-access", "fireflies-move-meeting",
  ].includes(normalizedToolName)) return "write";
  // Gmail archive removes a system label. Keep it behind the archive method's
  // destructive Ask-first default even when the preview provider omits hints.
  if (sourceTemplateKey === "gmail" && normalizedToolName === "unlabel-thread")
    return "destructive";
  if (sourceTemplateKey === "posthog" && normalizedToolName === "exec")
    return "destructive";
  // Superagent mirrors its REST API, and several mutations use verbs the
  // generic classifier reads as reads: billable triage_finding, scans,
  // restore_agent_builtin_rule, and credential-revoking revoke_agent_client.
  // Only list/get tools and tools the provider marks read-only are reads.
  if (sourceTemplateKey === "superagent") {
    if (verbMatches(tool.name, "delete|remove|destroy|revoke")) return "destructive";
    if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
    return /^(list|get)-/.test(normalizedToolName) || annotations.readOnlyHint === true ? "read" : "write";
  }
  // Ditto's translate, link and unlink tools replace saved text or developer
  // IDs, but the generic classifier reads those verbs as reads. Only
  // list/get/search tools, suggest_edit, and tools Ditto marks read-only are
  // reads.
  if (sourceTemplateKey === "ditto") {
    if (verbMatches(tool.name, "delete|remove|destroy")) return "destructive";
    if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
    return /^(list|get|search)-/.test(normalizedToolName) ||
      normalizedToolName === "suggest-edit" ||
      annotations.readOnlyHint === true
      ? "read"
      : "write";
  }
  if (
    sourceTemplateKey === "shopify" &&
    SHOPIFY_DESTRUCTIVE_TOOLS.has(normalizedToolName)
  )
    return "destructive";
  // Notion's hosted MCP catalog contains mutations whose names do not use one
  // of the generic create/update/delete verbs (move, duplicate, and convert).
  // Keep all reviewed tools explicit so provider changes are visible in code,
  // while an annotation may still escalate a known read to a write.
  if (
    sourceTemplateKey === "notion" &&
    NOTION_WRITE_TOOLS.has(normalizedToolName)
  )
    return "write";
  if (annotations.readOnlyHint === false || annotations.writeHint === true)
    return "write";
  if (
    sourceTemplateKey === "notion" &&
    NOTION_READ_TOOLS.has(normalizedToolName)
  )
    return "read";
  if (verbMatches(tool.name, "delete|remove|destroy|unpublish"))
    return "destructive";
  if (
    verbMatches(
      tool.name,
      "create|update|write|set|send|publish|post|mutate|mark|archive",
    )
  )
    return "write";
  // PostHog exposes a broad and evolving catalog. Unknown tools must never be
  // silently treated as reads; provider annotations can opt known reads in.
  if (sourceTemplateKey === "posthog")
    return annotations.readOnlyHint === true ? "read" : "write";
  return "read";
}

export function isGmailToolPermanentlyBlocked(
  tool: McpToolDescriptor,
): boolean {
  if (googleWorkspaceToolLeafName(tool.name) === "unlabel-thread") return false;
  const riskLevel = classifyRisk(tool, "gmail");
  return (
    verbMatches(
      tool.name,
      "send|trash|spam|delete|remove|destroy|execute|run",
    ) ||
    (normalizedProviderToolName(tool.name).includes("label") &&
      riskLevel !== "read")
  );
}

const GOOGLE_WORKSPACE_READ_TOOLS: Record<string, ReadonlySet<string>> = {
  gmail: new Set([
    "get-message",
    "get-thread",
    "get-draft",
    "list-drafts",
    "list-labels",
    "search-threads",
    "list-threads",
    "search-messages",
  ]),
  "google-drive": new Set([
    "download-file-content",
    "get-file-metadata",
    "get-file-permissions",
    "list-recent-files",
    "read-file-content",
    "search-files",
  ]),
  "google-docs": new Set(["read-doc"]),
  "google-sheets": new Set(["get-values", "get-spreadsheet"]),
  "google-slides": new Set(["read-presentation"]),
  "google-calendar": new Set([
    "get-event",
    "list-calendars",
    "list-events",
    "search-events",
    "suggest-time",
  ]),
  "google-chat": new Set([
    "search-conversations",
    "list-messages",
    "search-messages",
  ]),
  "google-people": new Set([
    "search-directory-people",
    "search-contacts",
    "get-user-profile",
  ]),
  "google-workspace-search": new Set(["search-corpus"]),
};

function googleWorkspaceToolLeafName(name: string): string {
  return (name.split(/[.:/]/).pop() ?? name)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

export function isGoogleWorkspaceToolAllowed(
  profileId: GoogleWorkspaceConnectorProfileId,
  tool: McpToolDescriptor,
): boolean {
  if (profileId === "workspace.all") return googleWorkspaceToolTarget(tool.name) !== null;
  const profile = GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profileId];
  const toolName = googleWorkspaceToolLeafName(tool.name);
  const readTools =
    GOOGLE_WORKSPACE_READ_TOOLS[profile.appSlug] ?? new Set<string>();
  return (
    readTools.has(toolName) ||
    profile.writeTools.some(
      (writeTool) => googleWorkspaceToolLeafName(writeTool) === toolName,
    )
  );
}

export function shouldQuarantineNewEntries(
  connection: typeof toolConnections.$inferSelect,
): boolean {
  return Boolean(nativeProviderCatalogFor(connection) || restConnectorFor(connection)) || asRecord(connection.config).quarantineNewEntries === true;
}
