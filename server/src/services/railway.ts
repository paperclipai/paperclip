import { z } from "zod";
import { redactSensitiveText } from "../redaction.js";
import { initializeMcpHttpSession, mcpHttpRequestHeaders, parseMcpHttpResponseBody } from "./mcp-http.js";

export const RAILWAY_MCP_URL = "https://mcp.railway.com";
export const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";
export const RAILWAY_TOOL_PREFIX = "paperclip-railway-";
/** Reserve time for target checks while staying inside the gateway's 60s cap. */
export function railwayCommandBudgetMs(parameters: unknown): number {
  const seconds = parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>).timeoutSeconds : undefined;
  const requested = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 30;
  return Math.min(60_000, (Math.max(1, requested) + 10) * 1000);
}
export const RAILWAY_BLOCKED_TOOLS = new Set([
  "railway-agent", "accept-deploy",
  // A separate repository preflight cannot bind serviceInstanceDeployV2 to the
  // approved repository. Keep old catalog entries/calls blocked until Railway
  // provides an atomic repository + revision mutation.
  `${RAILWAY_TOOL_PREFIX}deploy-revision`,
]);
export function normalizeRailwayToolName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[:._-]+/g, "-");
}
export function isRailwayToolBlocked(name: string): boolean {
  return RAILWAY_BLOCKED_TOOLS.has(normalizeRailwayToolName(name));
}

/** Both branding and an exact endpoint are required for the built-in API bridge. */
export function isRailwayConnection(connection: {
  transport: string; authKind: string; credentialSource?: string;
  config: Record<string, unknown>;
}): boolean {
  return connection.transport === "mcp_remote" && connection.authKind === "oauth"
    && connection.credentialSource === "paperclip_vault"
    && connection.config.sourceTemplateKey === "railway"
    && connection.config.connectionMethodKey === "mcp-oauth"
    && isRailwayEndpoint(connection.config.url);
}

export function isRailwayEndpoint(value: unknown): boolean {
  return value === RAILWAY_MCP_URL || value === `${RAILWAY_MCP_URL}/`;
}

const id = z.string().uuid();
const paging = { first: z.number().int().min(1).max(100).default(25), after: z.string().max(512).optional() };
const target = { projectId: id, environmentId: id, serviceId: id };
const deploymentTarget = { ...target, deploymentId: id };
const timestamp = z.string().datetime({ offset: true }).optional();
const schema = {
  "list-projects": z.object({ workspaceId: id, ...paging }).strict(),
  "list-services": z.object({ projectId: id, ...paging }).strict(),
  "list-environments": z.object({ projectId: id, ...paging }).strict(),
  "service-status": z.object(target).strict(),
  "list-deployments": z.object({ ...target, ...paging }).strict(),
  "deployment-status": z.object(deploymentTarget).strict(),
  "read-logs": z.object({ ...deploymentTarget, kind: z.enum(["build", "runtime"]).default("runtime"), limit: z.number().int().min(1).max(500).default(100), startDate: timestamp, endDate: timestamp, filter: z.string().max(500).optional() }).strict(),
  redeploy: z.object(deploymentTarget).strict(),
  restart: z.object(deploymentTarget).strict(),
  rollback: z.object(deploymentTarget).strict(),
  "run-command": z.object({ ...deploymentTarget, deploymentInstanceId: id, command: z.string().min(1).max(8192), timeoutSeconds: z.number().int().min(1).max(60).default(30) }).strict(),
};
type Operation = keyof typeof schema;
const titles: Record<Operation, string> = {
  "list-projects": "List projects (direct)",
  "list-services": "List services (direct)",
  "list-environments": "List environments",
  "service-status": "Get service status",
  "list-deployments": "List deployments",
  "deployment-status": "Get deployment status",
  "read-logs": "Read deployment logs",
  redeploy: "Redeploy a deployment",
  restart: "Restart a deployment",
  rollback: "Roll back to a deployment",
  "run-command": "Run a container command",
};
const descriptions: Record<Operation, string> = {
  "list-projects": "List Railway projects in an explicit authorized workspace, with bounded pagination. Use the hosted list-workspaces action to find workspace IDs.",
  "list-services": "List services in one Railway project. Use service-status to inspect a specific environment.",
  "list-environments": "List environments in one Railway project.",
  "service-status": "Inspect a service's running and latest deployments in an explicit project and environment.",
  "list-deployments": "List deployments for one explicit project, environment, and service.",
  "deployment-status": "Inspect an exact deployment and its container instance IDs.",
  "read-logs": "Read at most 500 build or runtime log lines for an exact deployment. Output is bounded; logs may contain sensitive application data.",
  redeploy: "Redeploy an exact deployment using its previous image. This changes a running service.",
  restart: "Restart an exact deployment without rebuilding. This interrupts a running service.",
  rollback: "Roll back to an exact eligible deployment. This changes a running service.",
  "run-command": "Run a bounded noninteractive shell command in an exact deployed container using this connection's configured SSH key. Broad privileged access: commands can read secrets and mutate application data. Requires Container access setup. Timeout closes SSH; remote child termination is not guaranteed.",
};
const reads = new Set<Operation>(["list-projects", "list-services", "list-environments", "service-status", "list-deployments", "deployment-status", "read-logs"]);

export const RAILWAY_TOOLS = Object.entries(schema).map(([operation, validator]) => ({
  name: `${RAILWAY_TOOL_PREFIX}${operation}`,
  title: titles[operation as Operation],
  description: descriptions[operation as Operation],
  inputSchema: z.toJSONSchema(validator, { target: "draft-7", io: "input" }) as Record<string, unknown>,
  annotations: { readOnlyHint: reads.has(operation as Operation), destructiveHint: !reads.has(operation as Operation), idempotentHint: reads.has(operation as Operation), openWorldHint: true },
}));

export function railwayRisk(name: string): "read" | "write" | "destructive" {
  name = normalizeRailwayToolName(name);
  if (isRailwayToolBlocked(name)) return "destructive";
  const operation = name.slice(RAILWAY_TOOL_PREFIX.length) as Operation;
  if (name.startsWith(RAILWAY_TOOL_PREFIX) && operation in schema) return reads.has(operation) ? "read" : "destructive";
  if (["whoami", "list-projects", "list-services", "list-feature-flags", "get-feature-flag"].includes(name)) return "read";
  if (["redeploy", "accept-deploy", "railway-agent", "delete-feature-flag"].includes(name)) return "destructive";
  return "write";
}

export class RailwayError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); this.name = "RailwayError"; }
}

export interface RailwaySshInput {
  deploymentInstanceId: string; command: string; timeoutSeconds: number; signal: AbortSignal;
}
export interface RailwayClientOptions {
  authorization: string;
  request: (url: string, init: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  runCommand?: (input: RailwaySshInput) => Promise<unknown>;
}

const pageInfo = "pageInfo { hasNextPage endCursor }";
const deploymentFields = "id projectId environmentId serviceId status createdAt url canRedeploy canRollback";
const instanceFields = "id environmentId serviceId serviceName source { repo } latestDeployment { id status } activeDeployments { id status }";

/** All query documents are authored here. Caller input is only ever variables. */
export const RAILWAY_QUERIES = {
  projects: `query PaperclipRailwayProjects($workspaceId:String!,$first:Int!,$after:String) { projects(workspaceId:$workspaceId,first:$first,after:$after) { edges { node { id name workspaceId } } ${pageInfo} } }`,
  services: `query PaperclipRailwayServices($projectId:String!,$first:Int!,$after:String) { project(id:$projectId) { id services(first:$first,after:$after) { edges { node { id name projectId } } ${pageInfo} } } }`,
  environments: `query PaperclipRailwayEnvironments($projectId:String!,$first:Int!,$after:String) { project(id:$projectId) { id environments(first:$first,after:$after) { edges { node { id name projectId } } ${pageInfo} } } }`,
  target: `query PaperclipRailwayTarget($projectId:String!,$environmentId:String!,$serviceId:String!) { project(id:$projectId) { id } environment(id:$environmentId) { id projectId } service(id:$serviceId) { id projectId } serviceInstance(environmentId:$environmentId,serviceId:$serviceId) { ${instanceFields} } }`,
  deployment: `query PaperclipRailwayDeployment($deploymentId:String!) { deployment(id:$deploymentId) { ${deploymentFields} instances { id } } }`,
  deployments: `query PaperclipRailwayDeployments($input:DeploymentListInput!,$first:Int!,$after:String) { deployments(input:$input,first:$first,after:$after) { edges { node { ${deploymentFields} } } ${pageInfo} } }`,
  buildLogs: `query PaperclipRailwayBuildLogs($deploymentId:String!,$limit:Int!,$startDate:DateTime,$endDate:DateTime,$filter:String) { buildLogs(deploymentId:$deploymentId,limit:$limit,startDate:$startDate,endDate:$endDate,filter:$filter) { timestamp message severity } }`,
  runtimeLogs: `query PaperclipRailwayRuntimeLogs($deploymentId:String!,$limit:Int!,$startDate:DateTime,$endDate:DateTime,$filter:String) { deploymentLogs(deploymentId:$deploymentId,limit:$limit,startDate:$startDate,endDate:$endDate,filter:$filter) { timestamp message severity } }`,
  redeploy: `mutation PaperclipRailwayRedeploy($deploymentId:String!) { deploymentRedeploy(id:$deploymentId,usePreviousImageTag:true) { id status } }`,
  restart: `mutation PaperclipRailwayRestart($deploymentId:String!) { deploymentRestart(id:$deploymentId) }`,
  rollback: `mutation PaperclipRailwayRollback($deploymentId:String!) { deploymentRollback(id:$deploymentId) }`,
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new RailwayError("railway_invalid_response", "Railway returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new RailwayError("railway_output_limit", "Railway's response exceeded the limit. Request fewer results or a shorter log interval.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Discover a consented workspace without requesting account-wide API access. */
export async function discoverRailwayWorkspace(options: RailwayClientOptions): Promise<string> {
  const send = (init: RequestInit) => options.request(RAILWAY_MCP_URL, { ...init, redirect: "error", signal: options.signal });
  const headers = { Authorization: options.authorization };
  const list = (requestHeaders: Record<string, string>) => send({
    method: "POST", headers: mcpHttpRequestHeaders(requestHeaders),
    body: JSON.stringify({ jsonrpc: "2.0", id: "paperclip-railway-workspace-probe", method: "tools/call", params: { name: "list-workspaces", arguments: {} } }),
  });
  let response = await list(headers);
  if (response.status === 400) {
    await response.body?.cancel();
    response = await list(await initializeMcpHttpSession({ send, headers, requestId: "paperclip-railway-workspace-probe" }));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RailwayError("railway_workspace_discovery_failed", "Railway's hosted connection is connected, but workspace access could not be checked. Refresh actions to try again.");
  }
  const body = await boundedResponseText(response, options.signal);
  let data: Record<string, any>;
  try {
    const payload = record(parseMcpHttpResponseBody(body, response.headers.get("content-type")));
    const result = record(payload.result);
    if (payload.error || result.isError) throw new Error("Workspace discovery failed");
    data = record(result.structuredContent ?? JSON.parse(result.content?.find((item: any) => item.type === "text")?.text ?? "{}"));
  } catch { throw new RailwayError("railway_workspace_discovery_failed", "Railway could not list authorized workspaces. Refresh actions or reconnect and select a workspace."); }
  const workspaceId = Array.isArray(data.workspaces) ? data.workspaces.find((workspace) => id.safeParse(workspace?.id).success)?.id : undefined;
  if (!workspaceId) throw new RailwayError("railway_workspace_required", "No authorized Railway workspace was found. Reconnect Railway and select a workspace to enable direct operations.", 403);
  return workspaceId;
}

export function createRailwayClient(options: RailwayClientOptions) {
  if (!/^Bearer [^\r\n]+$/.test(options.authorization)) throw new RailwayError("railway_authorization_required", "Reconnect Railway to authorize API access.", 401);
  const secret = options.authorization.slice(7);
  const redact = (value: unknown) => JSON.parse(redactSensitiveText(JSON.stringify(value).split(secret).join("[REDACTED]")));

  async function query(document: string, variables: Record<string, unknown>): Promise<Record<string, any>> {
    options.signal.throwIfAborted();
    let response: Response;
    try {
      response = await options.request(RAILWAY_API_URL, { method: "POST", redirect: "error", signal: options.signal, headers: { "content-type": "application/json", Authorization: options.authorization }, body: JSON.stringify({ query: document, variables }) });
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      throw new RailwayError("railway_request_failed", "Railway could not be reached. A deployment request may have succeeded; inspect deployment status before retrying.");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new RailwayError("railway_api_authorization_required", "Railway rejected API access. Reconnect with access to the required workspace or project. Hosted connection tokens are used only if Railway accepts them for API access.", response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RailwayError(response.status === 429 ? "railway_rate_limited" : "railway_api_unavailable", response.status === 429 ? "Railway is rate limiting requests. Wait before trying again." : "Railway is unavailable. Check deployment status before retrying a deployment operation.");
    }
    const body = await boundedResponseText(response, options.signal);
    let payload: Record<string, any>;
    try { payload = record(JSON.parse(body)); }
    catch { throw new RailwayError("railway_invalid_response", "Railway returned an invalid API response."); }
    if (payload.errors) {
      // Provider errors can echo variables, credentials or application secrets.
      if (Array.isArray(payload.errors) && payload.errors.some((error) => ["UNAUTHENTICATED", "FORBIDDEN"].includes(error?.extensions?.code) || ["Not Authorized", "Unauthorized", "Forbidden"].includes(error?.message))) {
        throw new RailwayError("railway_api_authorization_required", "Railway denied this API request. Use IDs from a workspace selected during consent, or reconnect to grant access to the required workspace.", 403);
      }
      throw new RailwayError("railway_api_error", "Railway could not complete the request. Check target IDs, resource permissions, and deployment eligibility. Inspect status before retrying a mutation.");
    }
    if (!payload.data || typeof payload.data !== "object") throw new RailwayError("railway_invalid_response", "Railway returned no API data.");
    return payload.data;
  }

  async function validateTarget(args: Record<string, any>) {
    const data = await query(RAILWAY_QUERIES.target, { projectId: args.projectId, environmentId: args.environmentId, serviceId: args.serviceId });
    if (data.project?.id !== args.projectId || data.environment?.id !== args.environmentId || data.environment?.projectId !== args.projectId || data.service?.id !== args.serviceId || data.service?.projectId !== args.projectId || data.serviceInstance?.environmentId !== args.environmentId || data.serviceInstance?.serviceId !== args.serviceId) {
      throw new RailwayError("railway_target_mismatch", "The service and environment do not belong to the selected Railway project.", 403);
    }
    return data.serviceInstance;
  }

  async function validateDeployment(args: Record<string, any>) {
    const data = await query(RAILWAY_QUERIES.deployment, { deploymentId: args.deploymentId });
    const d = record(data.deployment);
    if (d.id !== args.deploymentId || d.projectId !== args.projectId || d.environmentId !== args.environmentId || d.serviceId !== args.serviceId) throw new RailwayError("railway_target_mismatch", "The deployment does not belong to the selected Railway target.", 403);
    return d;
  }

  return {
    async probe(workspaceId: string) {
      if (!id.safeParse(workspaceId).success) throw new RailwayError("railway_workspace_required", "Choose an authorized Railway workspace before checking API access.", 400);
      await query(RAILWAY_QUERIES.projects, { workspaceId, first: 1 });
    },
    async call(name: string, parameters: unknown): Promise<unknown> {
      if (isRailwayToolBlocked(name)) throw new RailwayError("railway_action_blocked", "This Railway action cannot bind its effects to an approved target. Use redeploy, restart, or rollback for an existing deployment.", 403);
      const operation = name.slice(RAILWAY_TOOL_PREFIX.length) as Operation;
      if (!name.startsWith(RAILWAY_TOOL_PREFIX) || !Object.hasOwn(schema, operation)) throw new RailwayError("railway_unknown_tool", "Unknown Railway operation.", 400);
      const parsed = schema[operation].safeParse(parameters);
      if (!parsed.success) throw new RailwayError("railway_invalid_arguments", "Invalid Railway operation arguments. Use the exact IDs and limits in the action schema.", 400);
      const args = parsed.data as Record<string, any>;
      let result: unknown;
      if (operation === "list-projects") result = await query(RAILWAY_QUERIES.projects, args);
      else if (operation === "list-services" || operation === "list-environments") result = await query(operation === "list-services" ? RAILWAY_QUERIES.services : RAILWAY_QUERIES.environments, args);
      else {
        const instance = await validateTarget(args);
        const deployment = args.deploymentId ? await validateDeployment(args) : null;
        switch (operation) {
          case "service-status": result = instance; break;
          case "deployment-status": result = deployment; break;
          case "list-deployments": result = await query(RAILWAY_QUERIES.deployments, { input: { projectId: args.projectId, environmentId: args.environmentId, serviceId: args.serviceId }, first: args.first, after: args.after }); break;
          case "read-logs": {
            if (args.startDate && args.endDate && Date.parse(args.startDate) > Date.parse(args.endDate)) throw new RailwayError("railway_invalid_arguments", "Log start time must precede end time.", 400);
            const data = await query(args.kind === "build" ? RAILWAY_QUERIES.buildLogs : RAILWAY_QUERIES.runtimeLogs, { deploymentId: args.deploymentId, limit: args.limit, startDate: args.startDate, endDate: args.endDate, filter: args.filter });
            const lines = data[args.kind === "build" ? "buildLogs" : "deploymentLogs"];
            if (!Array.isArray(lines)) throw new RailwayError("railway_invalid_response", "Railway returned invalid log data.");
            let bytes = 0;
            let messageTruncated = false;
            const bounded = [];
            for (const line of lines.slice(0, args.limit)) {
              const message = String(line.message ?? "");
              if (message.length > 8192) messageTruncated = true;
              const safe = redact({ timestamp: line.timestamp, severity: line.severity, message: message.slice(0, 8192) });
              bytes += Buffer.byteLength(JSON.stringify(safe));
              if (bytes > 64 * 1024) break;
              bounded.push(safe);
            }
            result = { deploymentId: args.deploymentId, kind: args.kind, lines: bounded, truncated: messageTruncated || bounded.length < lines.length, limitReached: lines.length >= args.limit }; break;
          }
          case "redeploy":
            if (!deployment?.canRedeploy) throw new RailwayError("railway_deployment_ineligible", "Railway does not allow this deployment to be redeployed.", 409);
            result = await query(RAILWAY_QUERIES.redeploy, { deploymentId: args.deploymentId });
            if (!id.safeParse(record(record(result).deploymentRedeploy).id).success) throw new RailwayError("railway_operation_unconfirmed", "Railway did not confirm a resulting deployment. Inspect deployment status before retrying.");
            break;
          case "restart":
            result = await query(RAILWAY_QUERIES.restart, { deploymentId: args.deploymentId });
            if (record(result).deploymentRestart !== true) throw new RailwayError("railway_operation_unconfirmed", "Railway did not confirm the restart. Inspect deployment status before retrying.");
            result = { ...record(result), targetDeploymentId: args.deploymentId };
            break;
          case "rollback":
            if (!deployment?.canRollback) throw new RailwayError("railway_deployment_ineligible", "Railway does not allow rollback to this deployment.", 409);
            result = await query(RAILWAY_QUERIES.rollback, { deploymentId: args.deploymentId });
            if (record(result).deploymentRollback !== true) throw new RailwayError("railway_operation_unconfirmed", "Railway did not confirm the rollback. Inspect deployment status before retrying.");
            result = { ...record(result), targetDeploymentId: args.deploymentId };
            break;
          case "run-command":
            if (!Array.isArray(deployment?.instances) || !deployment.instances.some((entry: { id: string }) => entry.id === args.deploymentInstanceId) || deployment.status !== "SUCCESS") throw new RailwayError("railway_target_mismatch", "The container instance is not part of the selected running deployment.", 403);
            if (!options.runCommand) throw new RailwayError("railway_ssh_setup_required", "Configure Container access on this Railway connection before running commands.", 422);
            result = await options.runCommand({ deploymentInstanceId: args.deploymentInstanceId, command: args.command, timeoutSeconds: args.timeoutSeconds, signal: options.signal }); break;
        }
      }
      return redact(result ?? null);
    },
  };
}
