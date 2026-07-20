import type {
  ToolApplication,
  ToolConnection,
  ToolMcpGatewayClientSnippet,
  ToolMcpGatewayToken,
  ToolMcpGatewayWithTokens,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import { humanizeConnectionDisplayName, isToolConnectionAttentionHealth } from "@paperclipai/shared";

/** Days before expiry at which we surface a token as "Expiring". */
export const TOKEN_EXPIRING_WINDOW_DAYS = 14;

export type TokenStatus = "active" | "expiring" | "expired" | "revoked";

export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Reveal-once, then masked. We never persist the full token in the DOM. */
export function maskedTokenLabel(token: Pick<ToolMcpGatewayToken, "tokenPrefix">): string {
  return `${token.tokenPrefix}•••`;
}

export function tokenStatus(
  token: Pick<ToolMcpGatewayToken, "revokedAt" | "expiresAt">,
  now: number = Date.now(),
): TokenStatus {
  if (token.revokedAt) return "revoked";
  const expires = toDate(token.expiresAt);
  if (!expires) return "active";
  const diffMs = expires.getTime() - now;
  if (diffMs <= 0) return "expired";
  if (diffMs <= TOKEN_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000) return "expiring";
  return "active";
}

export const TOKEN_STATUS_LABEL: Record<TokenStatus, string> = {
  active: "Active",
  expiring: "Expiring",
  expired: "Expired",
  revoked: "Revoked",
};

/** Count of tokens that can currently authenticate (not revoked, not expired). */
export function activeTokenCount(gateway: ToolMcpGatewayWithTokens, now: number = Date.now()): number {
  return gateway.tokens.filter((token) => {
    const status = tokenStatus(token, now);
    return status === "active" || status === "expiring";
  }).length;
}

export function expiringTokenCount(gateway: ToolMcpGatewayWithTokens, now: number = Date.now()): number {
  return gateway.tokens.filter((token) => tokenStatus(token, now) === "expiring").length;
}

export function latestTokenActivity(gateway: ToolMcpGatewayWithTokens): Date | null {
  return gateway.tokens.reduce<Date | null>((latest, token) => {
    const candidate = toDate(token.lastUsedAt);
    if (!candidate) return latest;
    return !latest || candidate.getTime() > latest.getTime() ? candidate : latest;
  }, null);
}

function shortId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

/** Prosumer "Scope" label — Company / Project · X / Agent · X. */
export function formatScope(
  gateway: ToolMcpGatewayWithTokens,
  projectNames: Map<string, string>,
  agentNames: Map<string, string>,
): string {
  if (gateway.contextScopeType !== "none" && gateway.contextScopeId) {
    if (gateway.contextScopeType === "project") {
      return `Project · ${projectNames.get(gateway.contextScopeId) ?? shortId(gateway.contextScopeId)}`;
    }
    if (gateway.contextScopeType === "agent") {
      return `Agent · ${agentNames.get(gateway.contextScopeId) ?? shortId(gateway.contextScopeId)}`;
    }
    return `${gateway.contextScopeType} · ${shortId(gateway.contextScopeId)}`;
  }
  if (gateway.projectId) return `Project · ${projectNames.get(gateway.projectId) ?? shortId(gateway.projectId)}`;
  if (gateway.agentId) return `Agent · ${agentNames.get(gateway.agentId) ?? shortId(gateway.agentId)}`;
  return "Company";
}

export function formatOwner(gateway: ToolMcpGatewayWithTokens, agentNames: Map<string, string>): string {
  if (gateway.createdByAgentId) {
    return agentNames.get(gateway.createdByAgentId) ?? `Agent ${shortId(gateway.createdByAgentId)}`;
  }
  return "Board";
}

/** Whether the gateway is exposing tools to clients right now. */
export function isGatewayOn(gateway: ToolMcpGatewayWithTokens): boolean {
  return gateway.status === "active";
}

/** Human summary of how many tools a profile allows. */
export function allowedToolsLabel(profile: ToolProfileWithDetails | undefined): string {
  if (!profile) return "Profile unavailable";
  const { accessMode, allowedToolCount, totalToolCount, excludedToolCount } = profile.summary;
  const count =
    accessMode === "all_except"
      ? Math.max(totalToolCount - excludedToolCount, 0)
      : allowedToolCount;
  if (count === 0) return "No tools allowed";
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

export type GatewayAppRow = {
  application: ToolApplication;
  connection: ToolConnection | null;
  toolCount: number;
  needsAttention: boolean;
  attentionReason: string | null;
};

/**
 * Derive the "Apps in this gateway" list from the bound profile's include
 * entries, joined to the company's applications and connections. Missing
 * credentials / unreachable servers surface through the connection health
 * status, mirroring the connection-level "Needs attention" contract — the
 * gateway does not own a separate credential store.
 */
export function deriveGatewayApps(
  profile: ToolProfileWithDetails | undefined,
  applications: ToolApplication[],
  connections: ToolConnection[],
): GatewayAppRow[] {
  if (!profile) return [];
  const applicationsById = new Map(applications.map((app) => [app.id, app]));
  const connectionsById = new Map(connections.map((conn) => [conn.id, conn]));
  const connectionsByApplication = new Map<string, ToolConnection[]>();
  for (const conn of connections) {
    connectionsByApplication.set(conn.applicationId, [
      ...(connectionsByApplication.get(conn.applicationId) ?? []),
      conn,
    ]);
  }

  const toolCountByApp = new Map<string, number>();
  const includedApplicationIds = new Set<string>();
  for (const entry of profile.entries ?? []) {
    if (entry.effect !== "include") continue;
    let applicationId = entry.applicationId ?? null;
    if (!applicationId && entry.connectionId) {
      applicationId = connectionsById.get(entry.connectionId)?.applicationId ?? null;
    }
    if (!applicationId) continue;
    includedApplicationIds.add(applicationId);
    if (entry.catalogEntryId || entry.toolName) {
      toolCountByApp.set(applicationId, (toolCountByApp.get(applicationId) ?? 0) + 1);
    }
  }

  const rows: GatewayAppRow[] = [];
  for (const applicationId of includedApplicationIds) {
    const application = applicationsById.get(applicationId);
    if (!application || application.status === "archived") continue;
    const appConnections = connectionsByApplication.get(applicationId) ?? [];
    const connection =
      appConnections.find((conn) => conn.status !== "archived") ?? appConnections[0] ?? null;
    const attentionConnection = appConnections.find((conn) =>
      isToolConnectionAttentionHealth(conn.healthStatus),
    );
    rows.push({
      application,
      connection,
      toolCount: toolCountByApp.get(applicationId) ?? 0,
      needsAttention: Boolean(attentionConnection),
      attentionReason: attentionConnection
        ? "Sign-in expired — reconnect to restore access."
        : null,
    });
  }
  return rows.sort((a, b) => a.application.name.localeCompare(b.application.name));
}

export function gatewayAppDisplayName(row: GatewayAppRow): string {
  return row.connection
    ? humanizeConnectionDisplayName(row.connection)
    : humanizeConnectionDisplayName(row.application.name);
}

const SNIPPET_CLIENT_ORDER: ToolMcpGatewayClientSnippet["client"][] = [
  "cursor",
  "claude_desktop",
  "vscode",
  "claude_code",
  "opencode",
];

export function orderedSnippets(
  snippets: ToolMcpGatewayClientSnippet[],
): ToolMcpGatewayClientSnippet[] {
  return [...snippets].sort(
    (a, b) => SNIPPET_CLIENT_ORDER.indexOf(a.client) - SNIPPET_CLIENT_ORDER.indexOf(b.client),
  );
}

export function formatSnippetConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}
