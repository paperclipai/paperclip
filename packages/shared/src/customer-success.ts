/** Version 1 inspection wire contract. Keep Cloud's protocol.ts byte-identical. */
export const INSPECTION_VERSION = 1;
export const INSPECTION_AUDIENCE = "paperclip-customer-success/v1";
export const INSPECTION_PERMIT_TYPE = "paperclip-inspection+jwt";
export const INSPECTION_HEADER = "x-paperclip-cloud-inspection";
export const CHALLENGE_DOMAIN = "paperclip-customer-success-challenge/v1\n";
export const MAX_INSPECTION_BYTES = 1024 * 1024;
export const MAX_INSPECTION_ROWS = 100;
export const INSPECTION_RESOURCES = [
  "companies",
  "goals",
  "users",
  "memberships",
  "permissions",
  "agents",
  "agentIdentities",
  "agentInstructions",
  "agentConfigRevisions",
  "tasks",
  "comments",
  "documents",
  "documentRevisions",
  "taskDocuments",
  "interactions",
  "approvals",
  "approvalComments",
  "decisions",
  "routines",
  "routineTriggers",
  "routineRuns",
  "routineRevisions",
  "routineDocuments",
  "projects",
  "projectWorkspaces",
  "projectMemberships",
  "skills",
  "skillVersions",
  "skillSources",
  "runs",
  "runEvents",
  "traceMetadata",
  "activity",
  "costs",
  "workProducts",
  "artifacts",
  "attachments",
  "connections",
  "connectionInstalls",
  "connectionGrants",
  "connectionGrantMembers",
  "connectionCatalog",
  "toolProfiles",
  "toolProfileEntries",
  "agentMemberships",
  "agentCommentary",
  "skillPolicies",
  "projectGoals",
  "labels",
  "taskLabels",
  "taskRelations",
  "taskApprovals",
  "documentMemberships",
  "documentThreads",
  "documentComments",
  "threads",
] as const;
export type InspectionResource = (typeof INSPECTION_RESOURCES)[number];
export interface InspectionQuery {
  operation:
    | "list"
    | "get"
    | "instructions.file"
    | "skills.file"
    | "runs.log"
    | "files.list"
    | "files.read"
    | "files.download"
    | "assets.content";
  resource?: InspectionResource;
  companyId?: string;
  resourceId?: string;
  parentId?: string;
  path?: string;
  versionId?: string;
  limit?: number;
  offset?: number;
  range?: { start: number; end: number };
  context?: {
    projectId?: string;
    workspaceId?: string;
    workspace?: "auto" | "execution" | "project";
  };
}
export interface RunAuthority {
  version: 1;
  instanceId: string;
  companyId: string;
  agentId: string;
  runId: string;
  keyId: string;
  active: true;
}
export interface InspectionPermit {
  v: 1;
  iss: "paperclip-cloud";
  aud: typeof INSPECTION_AUDIENCE;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  bindingVersion: number;
  grantId: string;
  requestId: string;
  agentId: string;
  keyId: string;
  runId: string;
  query: InspectionQuery;
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error("Invalid JSON value");
}
export function parseInspectionQuery(value: unknown): InspectionQuery {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid inspection query");
  const q = value as InspectionQuery;
  const allowed = new Set([
    "operation",
    "resource",
    "companyId",
    "resourceId",
    "parentId",
    "path",
    "versionId",
    "limit",
    "offset",
    "range",
    "context",
  ]);
  if (Object.keys(q).some((k) => !allowed.has(k)))
    throw new Error("Unsupported inspection parameter");
  if (
    ![
      "list",
      "get",
      "instructions.file",
      "skills.file",
      "runs.log",
      "files.list",
      "files.read",
      "files.download",
      "assets.content",
    ].includes(q.operation)
  )
    throw new Error("Unsupported inspection operation");
  for (const k of ["companyId", "resourceId", "parentId", "versionId"] as const) {
    if (q[k] !== undefined && (typeof q[k] !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(q[k]!)))
      throw new Error(`Invalid ${k}`);
  }
  if (q.resource !== undefined && !INSPECTION_RESOURCES.includes(q.resource))
    throw new Error("Unsupported inspection resource");
  if (q.operation === "get" && !q.resourceId) throw new Error("resourceId required");
  if (["get", "list"].includes(q.operation) && !q.resource) throw new Error("resource required");
  if (!(q.operation === "list" && q.resource === "companies") && !q.companyId)
    throw new Error("companyId required");
  if (!["get", "list"].includes(q.operation) && !q.resourceId)
    throw new Error("resourceId required");
  if (
    q.path !== undefined &&
    (typeof q.path !== "string" || q.path.length > 1024 || q.path.includes("\0"))
  )
    throw new Error("Invalid path");
  if (
    q.range !== undefined &&
    !["files.download", "assets.content", "runs.log"].includes(q.operation)
  )
    throw new Error("This operation does not support byte ranges");
  for (const k of ["limit", "offset"] as const)
    if (
      q[k] !== undefined &&
      (!Number.isSafeInteger(q[k]) || q[k]! < 0 || q[k]! > (k === "limit" ? 100 : 1000000))
    )
      throw new Error(`Invalid ${k}`);
  if (
    q.range !== undefined &&
    (!q.range ||
      typeof q.range !== "object" ||
      Array.isArray(q.range) ||
      Object.keys(q.range).sort().join(",") !== "end,start" ||
      !Number.isSafeInteger(q.range.start) ||
      !Number.isSafeInteger(q.range.end) ||
      q.range.start < 0 ||
      q.range.end < q.range.start ||
      q.range.end - q.range.start + 1 > MAX_INSPECTION_BYTES)
  )
    throw new Error("Invalid byte range");
  if (q.context !== undefined) {
    if (
      !q.context ||
      typeof q.context !== "object" ||
      Array.isArray(q.context) ||
      Object.keys(q.context).some((k) => !["projectId", "workspaceId", "workspace"].includes(k)) ||
      Object.values(q.context).some(
        (v) => typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v),
      ) ||
      (q.context.workspace !== undefined &&
        !["auto", "execution", "project"].includes(q.context.workspace))
    )
      throw new Error("Invalid file context");
  }
  return JSON.parse(canonicalJson(q)) as InspectionQuery;
}
