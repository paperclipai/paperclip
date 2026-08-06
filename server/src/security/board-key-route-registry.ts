import type { Request, RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  assets,
  boardApiKeyAuthorizationEvents,
  boardApiKeys,
  companySecretProviderConfigs,
  companySecrets,
  companies,
  decisionTrainingExamples,
  decisions,
  executionWorkspaces,
  folders,
  goals,
  heartbeatRuns,
  issueAttachments,
  issueWorkProducts,
  issues,
  labels,
  principalPermissionGrants,
  projects,
  routines,
  routineTriggers,
  statusCards,
  toolActionRequests,
  toolApplications,
  toolConnections,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
  workspaceOperations,
} from "@paperclipai/db";
import { isUuidLike, type BoardPermissionKey, type PermissionKey } from "@paperclipai/shared";
import { HttpError, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  BOARD_KEY_AUDIT_COUPLINGS,
  createBoardKeyAuditContext,
  runWithBoardKeyAuditContext,
  settleBoardKeyAuditContext,
  stageBoardKeyAllowAudit,
} from "./board-key-audit-coupling.js";

export type BoardKeyRouteClassification =
  | "company"
  | "company_collection"
  | "instance_global"
  | "key_self"
  | "board_key_denied"
  | "undeclared";

export type BoardKeyAuthoritativeResolver =
  | "none"
  | "company"
  | "issue"
  | "agent"
  | "project"
  | "goal"
  | "routine"
  | "approval"
  | "execution_workspace"
  | "asset"
  | "attachment"
  | "work_product"
  | "heartbeat_run"
  | "secret"
  | "secret_provider"
  | "tool_application"
  | "tool_connection"
  | "tool_profile"
  | "tool_profile_entry"
  | "tool_gateway"
  | "status_card"
  | "label"
  | "folder"
  | "routine_trigger"
  | "decision"
  | "decision_training"
  | "workspace_operation"
  | "key_self"
  | "downstream_company";

export interface BoardKeyRouteMetadata {
  method: string;
  routePattern: string;
  action: BoardPermissionKey | "deny";
  classification: BoardKeyRouteClassification;
  resolver: BoardKeyAuthoritativeResolver;
  resourceId?: string;
  companyId?: string;
  concealment: "forbidden" | "not_found";
}

type AuthoritativeResource = {
  companyId: string | null;
  resourceType: string | null;
  resourceId: string | null;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ID = "{id}";

function permissionForMethod(
  method: string,
  read: BoardPermissionKey,
  write: BoardPermissionKey,
): BoardPermissionKey {
  return SAFE_METHODS.has(method) ? read : write;
}

function declared(
  method: string,
  routePattern: string,
  action: BoardPermissionKey | "deny",
  classification: BoardKeyRouteClassification,
  resolver: BoardKeyAuthoritativeResolver,
  extra: Partial<Pick<BoardKeyRouteMetadata, "resourceId" | "companyId" | "concealment">> = {},
): BoardKeyRouteMetadata {
  return {
    method,
    routePattern,
    action,
    classification,
    resolver,
    concealment: extra.concealment ?? (resolver === "company" ? "forbidden" : "not_found"),
    ...(extra.resourceId ? { resourceId: extra.resourceId } : {}),
    ...(extra.companyId ? { companyId: extra.companyId } : {}),
  };
}

function denied(method: string, routePattern: string): BoardKeyRouteMetadata {
  return declared(method, routePattern, "deny", "board_key_denied", "none", { concealment: "forbidden" });
}

function normalizePath(rawPath: string) {
  const withoutQuery = rawPath.split("?", 1)[0] || "/";
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

function queryCompanyId(rawPath: string) {
  try {
    const value = new URL(rawPath, "http://paperclip.invalid").searchParams.get("companyId");
    return value && isUuidLike(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function companySubresourcePermission(method: string, subresource: string | undefined, tail: string[]) {
  const write = !SAFE_METHODS.has(method);
  switch (subresource) {
    case "agents":
    case "org":
      return write ? "agents:write" : "agents:read";
    case "projects": return write ? "projects:write" : "projects:read";
    case "issues": return write ? "issues:write" : "issues:read";
    case "goals": return write ? "goals:write" : "goals:read";
    case "routines": return write ? "routines:write" : "routines:read";
    case "approvals": return write ? "approvals:write" : "approvals:read";
    case "costs":
    case "finance-events":
    case "budgets": return write ? "costs:write" : "costs:read";
    case "activity": return "activity:read";
    case "artifacts":
    case "assets":
    case "attachments":
    case "work-products": return write ? "artifacts:write" : "artifacts:read";
    case "execution-workspaces":
    case "project-workspaces":
    case "workspaces": return write ? "workspaces:manage" : "workspaces:read";
    case "skills": return write ? "skills:manage" : "skills:read";
    case "tools":
    case "tool-applications":
    case "tool-connections":
    case "tool-profiles":
    case "tool-gateway": return write ? "tools:manage" : "tools:read";
    case "secrets":
    case "secret-provider-configs": return write ? "secrets:manage" : "secrets:read_metadata";
    case "members":
    case "users":
    case "invites":
    case "join-requests": return write ? "members:manage" : "members:read";
    case "decisions":
    case "decision-queues":
    case "decision-triage":
    case "decision-retention":
    case "decision-training": return write ? "decisions:write" : "decisions:read";
    case "labels":
    case "folders":
    case "summary-slots":
    case "status-cards":
    case "sidebar-preferences":
    case "resource-memberships": return write ? "settings:write" : "settings:read";
    case "environments": return write ? "environments:manage" : "environments:read";
    case "search": return "search:read";
    case "heartbeat-runs":
    case "runtime": return write ? "runtime:manage" : "runtime:read";
    case "audit": return "audit:read";
    case "import":
    case "export":
    case "exports": return "companies:import_export";
    default:
      if (tail.some((segment) => segment === "search" || segment === "extract")) return "search:read";
      return write ? "companies:write" : "companies:read";
  }
}

function issuePermission(method: string, tail: string[]) {
  if (tail.some((segment) => [
    "checkout",
    "release",
    "force-release",
    "retry-now",
    "check-now",
    "tree-control",
    "tree-holds",
    "watchdog",
    "recovery-actions",
    "scheduled-retry",
    "monitor",
    "inbox-archive",
    "read",
    "low-trust",
  ].includes(segment))) return "issues:control" as const;
  return permissionForMethod(method, "issues:read", "issues:write");
}

function agentPermission(method: string, tail: string[]) {
  if (tail.some((segment) => [
    "heartbeat",
    "wakeup",
    "pause",
    "resume",
    "terminate",
    "clear-error",
    "reset-session",
    "rollback",
  ].includes(segment))) return "agents:operate" as const;
  return permissionForMethod(method, "agents:read", "agents:write");
}

function isDeniedCompanyRoute(method: string, tail: string[]) {
  const joined = tail.join("/");
  if (
    joined.startsWith("adapters/")
    || joined === "agent-configurations"
    || joined.startsWith("built-in-agents")
    || joined === "feedback-traces"
    || joined.startsWith("inbox-dismissals")
    || joined.startsWith("me/user-secrets")
    || joined.startsWith("resource-memberships/me")
    || joined === "sidebar-preferences/me"
    || joined.startsWith("skill-policy")
    || joined.startsWith("teams/catalog")
    || joined.startsWith("openclaw/invite-prompt")
    || joined === "agent-hires"
  ) return true;
  if (tail[0] === "users" && (tail.at(-1) === "inbox-agent-policy" || tail.at(-1) === "profile")) return true;
  if (tail[0] === "skill-test-run-templates") return true;
  return method === "POST" && tail[0] === "skills" && tail.includes("test-runs") && tail.at(-1) === "run";
}

function isDeniedAgentRoute(resourceId: string | undefined, tail: string[]) {
  if (resourceId === "me") return true;
  return tail[0] === "keys"
    || (tail[0] === "instructions-bundle" && tail[1] === "file")
    || tail[0] === "claude-login";
}

function isDeniedPluginRoute(method: string, segments: string[]) {
  const tail = segments.slice(3);
  if (segments[2] === "tools" && tail[0] === "execute") return true;
  if (["actions", "bridge", "data", "webhooks"].includes(tail[0] ?? "")) return true;
  if (tail[0] === "companies" && tail[2] === "local-folders") return true;
  return method === "GET" && tail[0] === "bridge" && tail[1] === "stream";
}

function isDeniedToolGatewayRoute(method: string, segments: string[]) {
  const tail = segments.slice(2);
  if (tail[0] === "sessions") return true;
  if (tail[0] === "tools") return method === "GET" || tail[1] === "call";
  return false;
}

/**
 * Central route registry. It intentionally returns `undeclared` rather than a
 * permissive default. The inventory test exercises every checked-in route and
 * fails when a new first-class route family is not classified here.
 */
export function lookupBoardKeyRoute(methodInput: string, rawPath: string): BoardKeyRouteMetadata {
  const method = methodInput.toUpperCase();
  const path = normalizePath(rawPath);
  const segments = path.split("/").filter(Boolean);

  if (segments[0] === "mcp") return denied(method, "/mcp/{*path}");
  // Top-level (non-/api) surfaces mounted directly on the app. These are
  // reachable routes, so they are explicitly denied rather than left
  // undeclared: board keys never reach the MCP gateway protocol, the plugin
  // UI static asset server, or the public LLM discovery files. Any other
  // non-/api path stays undeclared and fails closed.
  if (segments[0] === "_plugins") return denied(method, "/_plugins/{*path}");
  if (segments[0] === "llms") return denied(method, "/llms/{*path}");
  if (segments[0] !== "api") {
    return declared(method, path, "deny", "undeclared", "none", { concealment: "forbidden" });
  }

  const top = segments[1];
  if (!top) return denied(method, "/api");

  if (top === "board-api-keys") {
    if (method === "DELETE" && segments.length === 3) {
      return declared(method, `/api/board-api-keys/${ID}`, "board_api_keys:revoke_self", "key_self", "key_self", {
        resourceId: segments[2],
        concealment: "not_found",
      });
    }
    return denied(method, `/api/board-api-keys${segments.length > 2 ? `/${ID}` : ""}`);
  }

  if ([
    "auth",
    "cli-auth",
    "health",
    "openapi.json",
    "invites",
    "join-requests",
    "board-claim",
    "profile",
    "get-session",
    "sidebar-preferences",
    "llms",
    "cloud",
    "stacks",
    "smoke-lab",
    "cases",
    "pipelines",
    "_plugins",
  ].includes(top)) return denied(method, `/api/${top}/{*path}`);

  if (top === "companies") {
    const companyId = segments[2];
    if (!companyId) {
      if (method === "GET") {
        return declared(method, "/api/companies", "companies:read", "company_collection", "none", { concealment: "forbidden" });
      }
      if (method === "POST") {
        return declared(method, "/api/companies", "companies:create", "instance_global", "none", { concealment: "forbidden" });
      }
      return denied(method, "/api/companies");
    }
    if (["import", "imports", "export", "exports"].includes(companyId)) {
      return declared(method, `/api/companies/${companyId}/{*path}`, "companies:import_export", "instance_global", "none", {
        concealment: "forbidden",
      });
    }
    if (isDeniedCompanyRoute(method, segments.slice(3))) {
      return denied(method, `/api/companies/${ID}/${segments.slice(3).join("/")}`);
    }
    const action = companySubresourcePermission(method, segments[3], segments.slice(4));
    return declared(method, `/api/companies/${ID}/{*path}`, action, "company", "company", {
      companyId,
      concealment: segments.length > 3 ? "not_found" : "forbidden",
    });
  }

  const resourceId = segments[2];
  const tail = segments.slice(3);
  const collectionCompanyId = resourceId ? undefined : queryCompanyId(rawPath);
  const companyCollectionRoute = (
    action: BoardPermissionKey,
    routePattern: string,
  ) => declared(method, routePattern, action, "company", "company", {
    companyId: collectionCompanyId,
    concealment: "not_found",
  });
  switch (top) {
    case "issues":
      if (!resourceId) return companyCollectionRoute(issuePermission(method, tail), "/api/issues?companyId={companyId}");
      return declared(method, `/api/issues/${ID}/{*path}`, issuePermission(method, tail), "company", "issue", { resourceId });
    case "agents":
      if (isDeniedAgentRoute(resourceId, tail)) return denied(method, `/api/agents/${ID}/{*path}`);
      if (!resourceId) return companyCollectionRoute(agentPermission(method, tail), "/api/agents?companyId={companyId}");
      return declared(method, `/api/agents/${ID}/{*path}`, agentPermission(method, tail), "company", "agent", { resourceId });
    case "projects":
      if (!resourceId) return companyCollectionRoute(permissionForMethod(method, "projects:read", "projects:write"), "/api/projects?companyId={companyId}");
      return declared(method, `/api/projects/${ID}/{*path}`, permissionForMethod(method, "projects:read", "projects:write"), "company", "project", { resourceId });
    case "goals":
      if (!resourceId) return companyCollectionRoute(permissionForMethod(method, "goals:read", "goals:write"), "/api/goals?companyId={companyId}");
      return declared(method, `/api/goals/${ID}/{*path}`, permissionForMethod(method, "goals:read", "goals:write"), "company", "goal", { resourceId });
    case "routines": {
      const action = tail.includes("run") ? "routines:run" : permissionForMethod(method, "routines:read", "routines:write");
      return declared(method, `/api/routines/${ID}/{*path}`, action, "company", "routine", { resourceId });
    }
    case "approvals": {
      const action = tail.some((segment) => segment === "approve" || segment === "reject")
        ? "approvals:decide"
        : permissionForMethod(method, "approvals:read", "approvals:write");
      return declared(method, `/api/approvals/${ID}/{*path}`, action, "company", "approval", { resourceId });
    }
    case "execution-workspaces":
      return declared(method, `/api/execution-workspaces/${ID}/{*path}`, permissionForMethod(method, "workspaces:read", "workspaces:manage"), "company", "execution_workspace", { resourceId });
    case "attachments":
      return declared(method, `/api/attachments/${ID}/{*path}`, permissionForMethod(method, "artifacts:read", "artifacts:write"), "company", "attachment", { resourceId });
    case "assets":
      return declared(method, `/api/assets/${ID}/{*path}`, permissionForMethod(method, "artifacts:read", "artifacts:write"), "company", "asset", { resourceId });
    case "work-products":
      return declared(method, `/api/work-products/${ID}/{*path}`, permissionForMethod(method, "artifacts:read", "artifacts:write"), "company", "work_product", { resourceId });
    case "heartbeat-runs":
      return declared(method, `/api/heartbeat-runs/${ID}/{*path}`, permissionForMethod(method, "runtime:read", "runtime:manage"), "company", "heartbeat_run", { resourceId });
    case "environments":
    case "environment-leases":
    case "environment-custom-image-setup-sessions":
      return declared(method, `/api/${top}/${ID}/{*path}`, permissionForMethod(method, "environments:read", "environments:manage"), "company", "downstream_company", { resourceId });
    case "secrets":
      return declared(method, `/api/secrets/${ID}/{*path}`, permissionForMethod(method, "secrets:read_metadata", "secrets:manage"), "company", "secret", { resourceId });
    case "secret-provider-configs":
      return declared(method, `/api/secret-provider-configs/${ID}/{*path}`, permissionForMethod(method, "secrets:read_metadata", "secrets:manage"), "company", "secret_provider", { resourceId });
    case "tool-connections":
      return declared(method, `/api/tool-connections/${ID}/{*path}`, permissionForMethod(method, "tools:read", "tools:manage"), "company", "tool_connection", { resourceId });
    case "tool-profiles":
      return declared(method, `/api/tool-profiles/${ID}/{*path}`, permissionForMethod(method, "tools:read", "tools:manage"), "company", "tool_profile", { resourceId });
    case "tool-profile-entries":
      return declared(method, `/api/tool-profile-entries/${ID}/{*path}`, permissionForMethod(method, "tools:read", "tools:manage"), "company", "tool_profile_entry", { resourceId });
    case "tool-applications":
      return declared(method, `/api/tool-applications/${ID}/{*path}`, permissionForMethod(method, "tools:read", "tools:manage"), "company", "tool_application", { resourceId });
    case "status-cards":
      return declared(method, `/api/status-cards/${ID}/{*path}`, permissionForMethod(method, "settings:read", "settings:write"), "company", "status_card", { resourceId });
    case "labels":
      return declared(method, `/api/labels/${ID}/{*path}`, permissionForMethod(method, "settings:read", "settings:write"), "company", "label", { resourceId });
    case "folders":
      return declared(method, `/api/folders/${ID}/{*path}`, permissionForMethod(method, "settings:read", "settings:write"), "company", "folder", { resourceId });
    case "routine-triggers":
      if (resourceId === "public") return denied(method, "/api/routine-triggers/public/{id}/fire");
      return declared(method, `/api/routine-triggers/${ID}/{*path}`, "routines:write", "company", "routine_trigger", { resourceId });
    case "plugins":
      if (isDeniedPluginRoute(method, segments)) return denied(method, "/api/plugins/{*path}");
      return declared(method, `/api/plugins/${ID}/{*path}`, permissionForMethod(method, "plugins:read", "plugins:manage"), "instance_global", "none", { resourceId, concealment: "forbidden" });
    case "adapters":
      return declared(method, `/api/adapters/${ID}/{*path}`, permissionForMethod(method, "adapters:read", "adapters:manage"), "instance_global", "none", { resourceId, concealment: "forbidden" });
    case "instance":
    case "dev-server":
      return declared(method, `/api/${top}/{*path}`, permissionForMethod(method, "instance:read", "instance:manage"), "instance_global", "none", { concealment: "forbidden" });
    case "admin":
      return declared(method, "/api/admin/{*path}", permissionForMethod(method, "users:read", "users:manage"), "instance_global", "none", { concealment: "forbidden" });
    case "teams":
    case "skills":
    case "built-in-agents":
      return declared(method, `/api/${top}/{*path}`, permissionForMethod(method, "catalogs:read", "catalogs:manage"), "instance_global", "none", { concealment: "forbidden" });
    case "feedback-traces":
      return denied(method, "/api/feedback-traces/{*path}");
    case "decision-training":
      return declared(method, `/api/decision-training/${ID}/{*path}`, permissionForMethod(method, "decisions:read", "decisions:write"), "company", "decision_training", { resourceId });
    case "decisions":
      return declared(method, `/api/decisions/${ID}/{*path}`, permissionForMethod(method, "decisions:read", "decisions:write"), "company", "decision", { resourceId });
    case "workspace-operations":
      return declared(method, `/api/workspace-operations/${ID}/{*path}`, permissionForMethod(method, "workspaces:read", "workspaces:manage"), "company", "workspace_operation", { resourceId });
    case "stats":
      return declared(method, "/api/stats", "companies:read", "company_collection", "none", { concealment: "forbidden" });
    case "import":
      return declared(method, "/api/import/{*path}", "companies:import_export", "instance_global", "none", { concealment: "forbidden" });
    case "board":
    case "bootstrap":
      return denied(method, `/api/${top}/{*path}`);
    case "sidebar-preferences":
      return denied(method, "/api/sidebar-preferences/{*path}");
    case "tool-gateway":
      if (isDeniedToolGatewayRoute(method, segments)) return denied(method, "/api/tool-gateway/{*path}");
      return declared(method, "/api/tool-gateway/{*path}", permissionForMethod(method, "tools:read", "tools:manage"), "company", "tool_gateway", { resourceId: segments[3] });
    case "tools":
      if (segments[2] === "oauth") return denied(method, "/api/tools/oauth/{*path}");
      return declared(method, "/api/tools/{*path}", permissionForMethod(method, "tools:read", "tools:manage"), "company", "downstream_company", { resourceId });
    default:
      return declared(method, path, "deny", "undeclared", "none", { concealment: "forbidden" });
  }
}

async function resolveAuthoritativeResource(
  db: Db,
  metadata: BoardKeyRouteMetadata,
): Promise<AuthoritativeResource | null> {
  const id = metadata.resourceId;
  const resolveCompanyTableRow = async (
    table: { id: any; companyId: any },
    resourceType: string,
  ): Promise<AuthoritativeResource | null> => {
    if (!id || !isUuidLike(id)) return null;
    const row = await db.select({ id: table.id, companyId: table.companyId }).from(table as any)
      .where(eq(table.id, id)).then((rows) => rows[0] as { id: string; companyId: string } | undefined);
    return row ? { companyId: row.companyId, resourceType, resourceId: row.id } : null;
  };
  switch (metadata.resolver) {
    case "none": return { companyId: null, resourceType: null, resourceId: null };
    case "company": {
      if (!metadata.companyId) return null;
      const row = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, metadata.companyId)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.id, resourceType: "company", resourceId: row.id } : null;
    }
    case "issue": {
      if (!id) return null;
      const row = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues)
        .where(isUuidLike(id) ? eq(issues.id, id) : eq(issues.identifier, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.companyId, resourceType: "issue", resourceId: row.id } : null;
    }
    case "agent": {
      if (!id || !isUuidLike(id)) return null;
      const row = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.companyId, resourceType: "agent", resourceId: row.id } : null;
    }
    case "project": {
      if (!id || !isUuidLike(id)) return null;
      const row = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.companyId, resourceType: "project", resourceId: row.id } : null;
    }
    case "goal": {
      if (!id || !isUuidLike(id)) return null;
      const row = await db.select({ id: goals.id, companyId: goals.companyId }).from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.companyId, resourceType: "goal", resourceId: row.id } : null;
    }
    case "routine": {
      if (!id || !isUuidLike(id)) return null;
      const row = await db.select({ id: routines.id, companyId: routines.companyId }).from(routines).where(eq(routines.id, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.companyId, resourceType: "routine", resourceId: row.id } : null;
    }
    case "approval": {
      if (!id || !isUuidLike(id)) return null;
      const row = await db.select({ id: approvals.id, companyId: approvals.companyId }).from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.companyId, resourceType: "approval", resourceId: row.id } : null;
    }
    case "execution_workspace": {
      if (!id || !isUuidLike(id)) return null;
      const row = await db.select({ id: executionWorkspaces.id, companyId: executionWorkspaces.companyId }).from(executionWorkspaces).where(eq(executionWorkspaces.id, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: row.companyId, resourceType: "execution_workspace", resourceId: row.id } : null;
    }
    case "asset": return resolveCompanyTableRow(assets, "asset");
    case "attachment": return resolveCompanyTableRow(issueAttachments, "attachment");
    case "work_product": return resolveCompanyTableRow(issueWorkProducts, "work_product");
    case "heartbeat_run": return resolveCompanyTableRow(heartbeatRuns, "heartbeat_run");
    case "secret": return resolveCompanyTableRow(companySecrets, "secret");
    case "secret_provider": return resolveCompanyTableRow(companySecretProviderConfigs, "secret_provider_config");
    case "tool_application": return resolveCompanyTableRow(toolApplications, "tool_application");
    case "tool_connection": return resolveCompanyTableRow(toolConnections, "tool_connection");
    case "tool_profile": return resolveCompanyTableRow(toolProfiles, "tool_profile");
    case "tool_profile_entry": return resolveCompanyTableRow(toolProfileEntries, "tool_profile_entry");
    case "tool_gateway": {
      for (const [table, resourceType] of [
        [toolMcpGateways, "tool_gateway"],
        [toolMcpGatewayTokens, "tool_gateway_token"],
        [toolActionRequests, "tool_action_request"],
        [toolRuntimeSlots, "tool_runtime_slot"],
      ] as const) {
        const row = await resolveCompanyTableRow(table, resourceType);
        if (row) return row;
      }
      return null;
    }
    case "status_card": return resolveCompanyTableRow(statusCards, "status_card");
    case "label": return resolveCompanyTableRow(labels, "label");
    case "folder": return resolveCompanyTableRow(folders, "folder");
    case "routine_trigger": return resolveCompanyTableRow(routineTriggers, "routine_trigger");
    case "decision": return resolveCompanyTableRow(decisions, "decision");
    case "decision_training": return resolveCompanyTableRow(decisionTrainingExamples, "decision_training");
    case "workspace_operation": return resolveCompanyTableRow(workspaceOperations, "workspace_operation");
    case "key_self": {
      if (!id || !isUuidLike(id)) return null;
      const row = await db.select({ id: boardApiKeys.id, userId: boardApiKeys.userId }).from(boardApiKeys).where(eq(boardApiKeys.id, id)).then((rows) => rows[0] ?? null);
      return row ? { companyId: null, resourceType: "board_api_key", resourceId: row.id } : null;
    }
    case "downstream_company":
      return { companyId: null, resourceType: null, resourceId: id ?? null };
  }
}

function isWriteAction(action: BoardPermissionKey) {
  return /:(?:write|manage|control|operate|run|decide|create|import_export)$/.test(action);
}

// Board-key actions intentionally use a stable public vocabulary that is
// broader than the internal principal-grant vocabulary. Keep this exhaustive:
// actions with a granular grant boundary require every named live grant, while
// membership-backed actions are re-authorized by the fresh active membership
// and role checks in authorizeBoardKey. There is no permissive unmapped case.
type OwnerAuthorityRequirement =
  | { kind: "membership" }
  | { kind: "grants"; permissionKeys: readonly PermissionKey[] };

const membershipAuthority = { kind: "membership" } as const;
const grantAuthority = (...permissionKeys: PermissionKey[]) => ({
  kind: "grants" as const,
  permissionKeys,
});

const OWNER_AUTHORITY_REQUIREMENTS = {
  "companies:read": membershipAuthority,
  "companies:write": membershipAuthority,
  "agents:read": membershipAuthority,
  "agents:write": grantAuthority("agents:create", "agents:configure"),
  "agents:operate": grantAuthority("agents:configure"),
  "projects:read": membershipAuthority,
  "projects:write": membershipAuthority,
  "issues:read": membershipAuthority,
  "issues:write": grantAuthority("tasks:assign"),
  "issues:control": grantAuthority("tasks:assign", "tasks:manage_active_checkouts"),
  "goals:read": membershipAuthority,
  "goals:write": membershipAuthority,
  "routines:read": membershipAuthority,
  "routines:write": membershipAuthority,
  "routines:run": membershipAuthority,
  "approvals:read": membershipAuthority,
  "approvals:write": membershipAuthority,
  "approvals:decide": membershipAuthority,
  "costs:read": membershipAuthority,
  "costs:write": membershipAuthority,
  "activity:read": membershipAuthority,
  "artifacts:read": membershipAuthority,
  "artifacts:write": membershipAuthority,
  "workspaces:read": membershipAuthority,
  "workspaces:manage": membershipAuthority,
  "skills:read": membershipAuthority,
  "skills:manage": grantAuthority("skills:create"),
  "tools:read": membershipAuthority,
  "tools:manage": grantAuthority("tools:admin"),
  "secrets:read_metadata": membershipAuthority,
  "secrets:manage": membershipAuthority,
  "members:read": membershipAuthority,
  "members:manage": grantAuthority("users:invite", "users:manage_permissions", "joins:approve"),
  "decisions:read": membershipAuthority,
  "decisions:write": membershipAuthority,
  "settings:read": membershipAuthority,
  "settings:write": membershipAuthority,
  "environments:read": membershipAuthority,
  "environments:manage": grantAuthority("environments:manage"),
  "pipelines:read": membershipAuthority,
  "pipelines:write": grantAuthority("pipelines:write"),
  "search:read": membershipAuthority,
  "runtime:read": membershipAuthority,
  "runtime:manage": membershipAuthority,
  "audit:read": grantAuthority("audit:view_agent_actions"),
  "instance:read": membershipAuthority,
  "instance:manage": membershipAuthority,
  "companies:create": membershipAuthority,
  "companies:import_export": membershipAuthority,
  "plugins:read": membershipAuthority,
  "plugins:manage": membershipAuthority,
  "adapters:read": membershipAuthority,
  "adapters:manage": membershipAuthority,
  "users:read": membershipAuthority,
  "users:manage": membershipAuthority,
  "catalogs:read": membershipAuthority,
  "catalogs:manage": membershipAuthority,
  "backups:create": membershipAuthority,
  "board_api_keys:revoke_self": membershipAuthority,
} satisfies Record<BoardPermissionKey, OwnerAuthorityRequirement>;

async function ownerHasRequiredGrant(
  db: Db,
  ownerUserId: string,
  companyIds: readonly string[],
  action: BoardPermissionKey,
) {
  const requirement = OWNER_AUTHORITY_REQUIREMENTS[action];
  if (requirement.kind === "membership") return true;
  const { permissionKeys } = requirement;
  const rows = await db
    .select({
      companyId: principalPermissionGrants.companyId,
      permissionKey: principalPermissionGrants.permissionKey,
    })
    .from(principalPermissionGrants)
    .where(and(
      inArray(principalPermissionGrants.companyId, [...companyIds]),
      eq(principalPermissionGrants.principalType, "user"),
      eq(principalPermissionGrants.principalId, ownerUserId),
      inArray(principalPermissionGrants.permissionKey, [...permissionKeys]),
    ));
  const liveKeysByCompany = new Map<string, Set<string>>();
  for (const row of rows) {
    const liveKeys = liveKeysByCompany.get(row.companyId) ?? new Set<string>();
    liveKeys.add(row.permissionKey);
    liveKeysByCompany.set(row.companyId, liveKeys);
  }
  return companyIds.every((companyId) => {
    const liveKeys = liveKeysByCompany.get(companyId);
    return permissionKeys.every((permissionKey) => liveKeys?.has(permissionKey));
  });
}

async function auditDecision(
  db: Db,
  req: Request,
  metadata: BoardKeyRouteMetadata,
  resource: AuthoritativeResource | null,
  decision: "allow" | "deny",
  reason: string,
) {
  if (req.actor.source !== "board_key" || !req.actor.keyId || !req.actor.boardKeyOwnerId) return;
  const values = {
    boardApiKeyId: req.actor.keyId,
    ownerUserId: req.actor.boardKeyOwnerId,
    tokenPrefix: req.actor.boardKeyPrefix ?? null,
    action: metadata.action,
    classification: metadata.classification,
    authoritativeCompanyId: resource?.companyId ?? null,
    authoritativeResourceType: resource?.resourceType ?? null,
    authoritativeResourceId: resource?.resourceId ?? null,
    decision,
    reason,
    requestId: typeof req.id === "string" ? req.id : null,
    runId: isUuidLike(req.actor.runId) ? req.actor.runId : null,
    details: {} as Record<string, string | boolean | null>,
  };
  // An allow on an unsafe method authorizes a mutation, so its disposition is
  // staged and committed inside that mutation's transaction. Denials abort the
  // request and safe methods have no mutation to couple to, so both stay
  // immediately durable.
  if (decision === "allow" && !SAFE_METHODS.has(req.method) && stageBoardKeyAllowAudit(values)) return;
  if (decision === "allow" && !SAFE_METHODS.has(req.method)) {
    logger.warn(
      { boardApiKeyId: req.actor.keyId, action: metadata.action },
      "Board-key allow audited without a request context; disposition is not transactionally coupled",
    );
    values.details = { coupling: BOARD_KEY_AUDIT_COUPLINGS.detached };
  }
  await db.insert(boardApiKeyAuthorizationEvents).values(values);
}

async function denyBoardKey(
  db: Db,
  req: Request,
  metadata: BoardKeyRouteMetadata,
  resource: AuthoritativeResource | null,
  reason: string,
  conceal = metadata.concealment,
): Promise<never> {
  try {
    await auditDecision(db, req, metadata, resource, "deny", reason);
  } catch (err) {
    logger.warn({ err, boardApiKeyId: req.actor.keyId, action: metadata.action }, "Failed to audit denied board-key authorization");
  }
  if (conceal === "not_found") throw notFound();
  throw forbidden();
}

export async function authorizeBoardKey(
  db: Db,
  req: Request,
  action: BoardPermissionKey | "deny",
  authoritativeResourceResolver: () => Promise<AuthoritativeResource | null>,
  metadata: BoardKeyRouteMetadata,
) {
  if (req.actor.source !== "board_key") return;
  if (metadata.classification === "undeclared") {
    await denyBoardKey(db, req, metadata, null, "route_undeclared", "forbidden");
  }
  if (metadata.classification === "board_key_denied" || action === "deny") {
    await denyBoardKey(db, req, metadata, null, "route_denied", "forbidden");
  }

  const resource = await authoritativeResourceResolver();
  if (!resource) await denyBoardKey(db, req, metadata, null, "resource_not_found", "not_found");

  const scope = req.actor.boardKeyScope;
  const legacy = req.actor.boardKeyLegacyUnrestricted === true;
  const permissions = new Set(scope?.permissions ?? []);

  if (!legacy && !permissions.has(action as BoardPermissionKey)) {
    await denyBoardKey(db, req, metadata, resource, "permission_missing", "forbidden");
  }

  if (metadata.classification === "key_self") {
    if (resource?.resourceId !== req.actor.keyId) {
      await denyBoardKey(db, req, metadata, resource, "key_self_mismatch", "not_found");
    }
    const row = await db.select({ userId: boardApiKeys.userId }).from(boardApiKeys)
      .where(eq(boardApiKeys.id, req.actor.keyId!)).then((rows) => rows[0] ?? null);
    if (!row || row.userId !== req.actor.boardKeyOwnerId) {
      await denyBoardKey(db, req, metadata, resource, "key_owner_mismatch", "not_found");
    }
  } else if (metadata.classification === "instance_global") {
    if (!legacy && !scope?.instanceCapabilities.includes("instance_admin")) {
      await denyBoardKey(db, req, metadata, resource, "instance_capability_missing", "forbidden");
    }
    if (!req.actor.isInstanceAdmin) {
      await denyBoardKey(db, req, metadata, resource, "owner_instance_admin_missing", "forbidden");
    }
  } else if (metadata.classification === "company_collection") {
    const companyIds = req.actor.companyIds ?? [];
    if (companyIds.length === 0) {
      await denyBoardKey(db, req, metadata, resource, "owner_company_membership_missing", "forbidden");
    }
    if (!await ownerHasRequiredGrant(
      db,
      req.actor.boardKeyOwnerId!,
      companyIds,
      action as BoardPermissionKey,
    )) {
      await denyBoardKey(db, req, metadata, resource, "owner_permission_grant_missing", "forbidden");
    }
  } else if (metadata.resolver === "downstream_company") {
    // A family may be inventoried before it has a safe generic resolver. It is
    // available to migrated legacy keys through existing route-level checks,
    // but scoped keys fail closed until an authoritative resolver is added.
    if (!legacy) await denyBoardKey(db, req, metadata, resource, "authoritative_resolver_unavailable", "not_found");
  } else if (resource?.companyId) {
    const membership = req.actor.memberships?.find(
      (item) => item.companyId === resource.companyId && item.status === "active",
    );
    if (!membership || !(req.actor.companyIds ?? []).includes(resource.companyId)) {
      await denyBoardKey(db, req, metadata, resource, "company_scope_mismatch", "not_found");
    }
    if (isWriteAction(action as BoardPermissionKey) && membership?.membershipRole === "viewer") {
      await denyBoardKey(db, req, metadata, resource, "owner_role_read_only", "forbidden");
    }
    if (!await ownerHasRequiredGrant(
      db,
      req.actor.boardKeyOwnerId!,
      [resource.companyId],
      action as BoardPermissionKey,
    )) {
      await denyBoardKey(db, req, metadata, resource, "owner_permission_grant_missing", "forbidden");
    }
  }

  try {
    await auditDecision(db, req, metadata, resource, "allow", "authorized");
  } catch (err) {
    logger.error({ err, boardApiKeyId: req.actor.keyId, action }, "Board-key authorization audit failed closed");
    throw new HttpError(500, "Internal server error");
  }
}

export function boardKeyAuthorizationMiddleware(db: Db): RequestHandler {
  return async (req, res, next) => {
    if (req.actor.source !== "board_key") {
      next();
      return;
    }
    const metadata = lookupBoardKeyRoute(req.method, req.originalUrl);
    const context = createBoardKeyAuditContext();
    // A staged allow disposition that never reached a domain transaction is
    // resolved once the response is complete: recorded when the request
    // succeeded without a rollback, dropped otherwise.
    const settle = (statusCode: number) => {
      void settleBoardKeyAuditContext(db, context, statusCode);
    };
    res.on("finish", () => settle(res.statusCode));
    res.on("close", () => settle(res.writableEnded ? res.statusCode : 0));
    // The context stays active across the downstream handler chain, so the
    // instrumented database handle can couple the disposition to its mutation.
    await runWithBoardKeyAuditContext(context, async () => {
      try {
        await authorizeBoardKey(
          db,
          req,
          metadata.action,
          () => resolveAuthoritativeResource(db, metadata),
          metadata,
        );
        next();
      } catch (err) {
        next(err);
      }
    });
  };
}
