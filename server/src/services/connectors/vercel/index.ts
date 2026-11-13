import { HttpError } from "../../../errors.js";
import { redactSensitiveText } from "../../../redaction.js";
import { VERCEL_API_URL, vercelOperations, vercelTeamIdSchema } from "./catalog.js";
export { VERCEL_API_URL, VERCEL_METHOD, VERCEL_TOOLS, vercelRisk, isCurrentVercelCatalogEntry, isVercelConnection } from "./catalog.js";

export type VercelRequest = (url: string, init: RequestInit) => Promise<Response>;
const MAX_BYTES = 4 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const failure = (status: number, code: string, message: string) => new HttpError(status, message, { code });
const pick = (value: unknown, fields: string[]) => Object.fromEntries(Object.entries(record(value)).filter(([key]) => fields.includes(key)));
const projectFields = ["id", "name", "accountId", "framework", "buildCommand", "installCommand", "devCommand", "outputDirectory", "rootDirectory", "nodeVersion", "createdAt", "updatedAt"];
const deploymentFields = ["id", "uid", "name", "projectId", "url", "readyState", "state", "target", "createdAt", "created", "buildingAt", "ready", "errorCode"];
const envFields = ["id", "key", "type", "target", "gitBranch", "createdAt", "updatedAt"];
const domainFields = ["name", "apexName", "projectId", "verified", "verification", "gitBranch", "redirect", "redirectStatusCode"];
const pagination = (value: unknown) => pick(record(value).pagination, ["count", "next", "prev"]);
function collection(value: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(value[key])) throw failure(502, "vercel_invalid_response", "Vercel returned an invalid response.");
  return value[key];
}

/** Fixed provider operations only. Credentials come from the connection grant;
 * the gateway owns company, run, policy, approval and audit enforcement. */
export function vercelClient(headers: Record<string, string>, request: VercelRequest, configuredTeamId: unknown,
  signal: AbortSignal = AbortSignal.timeout(30_000), deadlineAt: number = Date.now() + 30_000) {
  // Do not pass unvalidated credentials through Headers: its validation error
  // can echo the rejected value into a logged exception.
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  if (!authorization || !/^Bearer [^\r\n]+$/.test(authorization)) throw failure(422, "vercel_credential_missing", "Reconnect Vercel to restore its access token.");
  const parsedTeam = vercelTeamIdSchema.safeParse(configuredTeamId);
  if (!parsedTeam.success) throw failure(422, "vercel_team_required", "Configure the Vercel team ID for this connection.");
  const teamId = parsedTeam.data;
  const token = authorization.slice(7);
  const deadlineError = failure(504, "vercel_deadline_exceeded", "The Vercel request timed out. A submitted operation may still complete; inspect its state before retrying.");

  async function withinDeadline<T>(work: () => Promise<T>): Promise<T> {
    if (signal.aborted || Date.now() >= deadlineAt) throw deadlineError;
    let abort!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (signal.aborted || Date.now() >= deadlineAt) throw deadlineError; return work(); }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(deadlineError);
          signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(abort, Math.max(0, deadlineAt - Date.now()));
        }),
      ]);
    } finally { signal.removeEventListener("abort", abort); if (timer) clearTimeout(timer); }
  }
  function sanitize(value: unknown): unknown {
    if (typeof value === "string") return redactSensitiveText(value.split(token).join("[REDACTED]"));
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.split(token).join("[REDACTED]"), sanitize(item)]));
    return value;
  }
  async function send(path: string, method = "GET", body?: unknown, query: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(path, VERCEL_API_URL);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    url.searchParams.set("teamId", teamId);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > MAX_BYTES) throw failure(422, "vercel_input_limit", "The Vercel request exceeds 4 MiB. Use a Git deployment for larger projects.");
    let response: Response;
    try {
      response = await withinDeadline(() => request(url.href, { method, headers: { Authorization: authorization!, "Content-Type": "application/json", "User-Agent": "Paperclip" },
        redirect: "error", signal, ...(serialized === undefined ? {} : { body: serialized }) }));
    } catch (error) {
      if (error === deadlineError || signal.aborted || Date.now() >= deadlineAt) throw deadlineError;
      throw failure(502, "vercel_outcome_unknown", "Vercel did not return a result. A submitted operation may still complete; inspect its state before retrying.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = [400, 401, 402, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
      throw failure(status, "vercel_request_failed", status === 401 || status === 403
        ? "Vercel denied access. Check the access token's team scope, expiration and role, then reconnect."
        : status === 429 ? "Vercel rate limited this request. Wait before retrying."
        : status === 404 ? "Vercel could not find this resource in the connected team."
        : status === 402 ? "Vercel requires a plan or billing change for this operation."
        : "Vercel could not complete this operation. Check the arguments and resource state before retrying.");
    }
    if (response.status === 204 || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const outputLimitError = failure(502, "vercel_output_limit", "Vercel's response exceeded 4 MiB. Request a smaller page.");
    try {
      for (;;) {
        const part = await withinDeadline(() => reader.read());
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_BYTES) throw outputLimitError;
        chunks.push(part.value);
      }
    } catch (error) {
      if (error === deadlineError || error === outputLimitError) throw error;
      throw failure(502, "vercel_outcome_unknown", "Vercel's response was interrupted. Inspect the operation before retrying.");
    } finally { void reader.cancel().catch(() => {}); }
    if (!length) return null;
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw failure(502, "vercel_invalid_response", "Vercel returned an invalid response."); }
  }
  function assertProject(value: unknown, requested?: string) {
    const project = record(value);
    if (project.accountId !== teamId || typeof project.id !== "string" || !/^prj_[A-Za-z0-9]+$/.test(project.id)
      || (requested && project.id !== requested && project.name !== requested)) {
      throw failure(403, "vercel_team_mismatch", "Vercel returned a project outside the configured team or requested target.");
    }
    return project;
  }
  async function getDeployment(projectId: string, deploymentId: string) {
    const value = record(await send(`/v13/deployments/${encodeURIComponent(deploymentId)}`));
    if (value.projectId !== projectId || value.id !== deploymentId) throw failure(403, "vercel_project_mismatch", "Vercel returned a deployment outside the selected project.");
    return value;
  }
  async function probe() {
    const value = record(await send(`/v2/teams/${encodeURIComponent(teamId)}`));
    if (value.id !== teamId) throw failure(403, "vercel_team_mismatch", "The Vercel token does not identify the configured team.");
    return { teamId };
  }
  async function invoke(name: string, parameters: unknown): Promise<unknown> {
    const operation = vercelOperations.find(candidate => candidate.name === name);
    if (!operation) throw failure(404, "vercel_tool_not_found", "Vercel action not found.");
    const parsed = operation.schema.safeParse(parameters);
    if (!parsed.success) throw failure(422, "vercel_arguments_invalid", "Invalid Vercel action arguments.");
    const args = record(parsed.data);
    // Validate all semantic constraints before even a read is dispatched.
    if (name === "vercel_create_deployment") {
      if ([args.files, args.gitSource, args.deploymentId].filter(value => value !== undefined).length !== 1) throw failure(422, "vercel_arguments_invalid", "Choose exactly one deployment source: files, gitSource or deploymentId.");
      const paths = new Set<string>();
      for (const value of (args.files as unknown[] | undefined) ?? []) {
        const file = record(value), path = String(file.file);
        if (path.startsWith("/") || /[\\\u0000-\u001f]/.test(path) || path.split("/").some(segment => !segment || segment === "." || segment === "..") || paths.has(path)) throw failure(422, "vercel_file_invalid", "Deployment files need unique relative paths without traversal.");
        paths.add(path);
        if (file.encoding === "base64" && Buffer.from(String(file.content), "base64").toString("base64") !== file.content) throw failure(422, "vercel_file_invalid", "Deployment files must use canonical base64 encoding.");
      }
    }
    if (name === "vercel_upsert_environment_variable" && args.type === "sensitive" && (args.target as string[]).includes("development")) throw failure(422, "vercel_arguments_invalid", "Vercel sensitive variables support preview and production targets only.");
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_BYTES) throw failure(422, "vercel_input_limit", "The Vercel request exceeds 4 MiB. Use a Git deployment for larger projects.");

    let project: Record<string, unknown> | undefined;
    if (typeof args.projectId === "string") project = assertProject(await send(`/v9/projects/${encodeURIComponent(args.projectId)}`), args.projectId);
    const projectId = project?.id as string;
    const projectPath = `/v9/projects/${encodeURIComponent(projectId ?? "")}`;
    const deploymentId = args.deploymentId as string;
    let result: unknown;
    switch (name) {
      case "vercel_list_projects": {
        const value = record(await send("/v10/projects", "GET", undefined, { limit: args.limit ?? 20, from: args.from }));
        result = { projects: collection(value, "projects").map(item => pick(assertProject(item), projectFields)), pagination: pagination(value) }; break;
      }
      case "vercel_get_project": result = pick(project, projectFields); break;
      case "vercel_create_project": result = pick(assertProject(await send("/v11/projects", "POST", { name: args.name, ...record(args.settings) }), String(args.name)), projectFields); break;
      case "vercel_update_project": result = pick(assertProject(await send(projectPath, "PATCH", args.settings), projectId), projectFields); break;
      case "vercel_delete_project": await send(projectPath, "DELETE"); result = { deleted: true, projectId }; break;
      case "vercel_list_deployments": {
        const value = record(await send("/v7/deployments", "GET", undefined, { projectId, limit: args.limit ?? 20, until: args.until }));
        result = { deployments: collection(value, "deployments").map(item => {
          if (record(item).projectId !== projectId) throw failure(403, "vercel_project_mismatch", "Vercel returned a deployment outside the selected project.");
          return pick(item, deploymentFields);
        }), pagination: pagination(value) }; break;
      }
      case "vercel_get_deployment": result = pick(await getDeployment(projectId, deploymentId), deploymentFields); break;
      case "vercel_create_deployment": {
        if (deploymentId) await getDeployment(projectId, deploymentId);
        const preview = args.target !== "production";
        if (preview) {
          // Vercel promotes the first deployment of an empty project to
          // production, including its environment variables. Failed/canceled
          // deployments count as history; deleted deployments do not.
          const existing = collection(record(await send("/v7/deployments", "GET", undefined, { projectId, limit: 1 })), "deployments");
          if (!existing.length) throw failure(409, "vercel_preview_requires_existing_deployment", "Vercel makes the first deployment of an empty project production. Use a project with an existing deployment for preview, or set target=production only when production deployment is authorized.");
          for (const item of existing) {
            const value = record(item), id = value.uid ?? value.id;
            if (typeof id !== "string" || !/^dpl_[A-Za-z0-9]{1,200}$/.test(id)) throw failure(502, "vercel_invalid_response", "Vercel did not confirm an existing deployment. No deployment was submitted.");
            if (value.projectId !== projectId) throw failure(403, "vercel_project_mismatch", "Vercel returned a deployment outside the selected project.");
          }
        }
        const files = (args.files as unknown[] | undefined)?.map(value => { const file = record(value); return { file: file.file, data: file.content, encoding: file.encoding ?? "utf-8" }; });
        const created = record(await send("/v13/deployments", "POST", { name: args.name, project: projectId,
          ...(args.target === "production" ? { target: "production" } : {}),
          ...(files ? { files } : {}), ...(args.gitSource ? { gitSource: args.gitSource } : {}), ...(deploymentId ? { deploymentId } : {}),
          projectSettings: args.projectSettings ?? pick(project, ["framework", "buildCommand", "installCommand", "devCommand", "outputDirectory", "rootDirectory", "nodeVersion"]),
        }));
        if (typeof created.id !== "string" || !/^dpl_[A-Za-z0-9]{1,200}$/.test(created.id) || typeof created.readyState !== "string") throw failure(502, "vercel_invalid_response", "Vercel did not confirm the deployment. Inspect its state before retrying.");
        if (created.projectId !== undefined && created.projectId !== projectId) throw failure(403, "vercel_project_mismatch", "Vercel returned a deployment outside the selected project.");
        if (preview && created.target !== null) {
          // The preflight cannot prevent concurrent external deletion of all
          // deployments. Persist the created identity for reconciliation and
          // idempotent replay instead of losing it in a post-write exception.
          result = { id: created.id, projectId, requestedTarget: "preview",
            target: created.target === "production" ? "production" : "unknown", reconciliationRequired: true,
            code: "vercel_deployment_target_mismatch",
            message: "Vercel created a deployment without confirming the requested preview environment. Inspect this deployment before any retry; it may use Production environment variables and domains." };
          break;
        }
        result = pick(created, deploymentFields); break;
      }
      case "vercel_cancel_deployment": await getDeployment(projectId, deploymentId); result = pick(await send(`/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`, "PATCH", {}), deploymentFields); break;
      case "vercel_delete_deployment": await getDeployment(projectId, deploymentId); await send(`/v13/deployments/${encodeURIComponent(deploymentId)}`, "DELETE"); result = { deleted: true, deploymentId }; break;
      case "vercel_list_environment_variables": {
        const value = record(await send(`/v10/projects/${encodeURIComponent(projectId)}/env`, "GET", undefined, { decrypt: false }));
        result = { envs: collection(value, "envs").map(item => pick(item, envFields)) }; break;
      }
      case "vercel_upsert_environment_variable": {
        const value = record(await send(`/v10/projects/${encodeURIComponent(projectId)}/env`, "POST", { key: args.key, value: args.secretValue, target: args.target, type: args.type ?? "encrypted", ...(args.gitBranch ? { gitBranch: args.gitBranch } : {}) }, { upsert: true }));
        if (Array.isArray(value.failed) && value.failed.length) throw failure(422, "vercel_environment_write_failed", "Vercel rejected the environment variable. Check the key, targets and provider permissions.");
        const created = record(Array.isArray(value.created) && value.created.length === 1 ? value.created[0] : value.created ?? value);
        if (typeof created.id !== "string" || created.key !== args.key) throw failure(502, "vercel_invalid_response", "Vercel did not confirm the environment variable write. Inspect its state before retrying.");
        result = pick(created, envFields); break;
      }
      case "vercel_delete_environment_variable": await send(`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(String(args.environmentVariableId))}`, "DELETE"); result = { deleted: true, environmentVariableId: args.environmentVariableId }; break;
      case "vercel_list_domains": {
        const value = record(await send(`/v9/projects/${encodeURIComponent(projectId)}/domains`, "GET", undefined, { limit: args.limit ?? 20, until: args.until }));
        result = { domains: collection(value, "domains").map(item => pick(item, domainFields)), pagination: pagination(value) }; break;
      }
      case "vercel_add_domain": result = pick(await send(`/v10/projects/${encodeURIComponent(projectId)}/domains`, "POST", { name: args.domain, ...(args.gitBranch ? { gitBranch: args.gitBranch } : {}) }), domainFields); break;
      case "vercel_verify_domain": result = pick(await send(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(String(args.domain))}/verify`, "POST", {}), domainFields); break;
      case "vercel_remove_domain": await send(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(String(args.domain))}`, "DELETE"); result = { removed: true, domain: args.domain }; break;
    }
    return sanitize(result);
  }
  return { probe, invoke };
}
