import { z } from "zod";
import { HttpError } from "../../../errors.js";
import { redactSensitiveText } from "../../../redaction.js";
import { descriptorHash, stableHash } from "../../tool-catalog-hash.js";

export const SUPABASE_API_URL = "https://api.supabase.com/v1";
export const SUPABASE_METHOD = "management-api";
export type SupabaseRequest = (url: string, init: RequestInit) => Promise<Response>;
const MAX_BYTES = 2 * 1024 * 1024;
const projectRefSchema = z.string().regex(/^[a-z]{20}$/);
const slugSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
// Relative, multipart-safe source names only. Nothing is read from the host.
const sourcePathSchema = z.string().max(200).regex(/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/);
const emptySchema = z.object({}).strict();
const functionSchema = z.object({ slug: slugSchema }).strict();
const secretSchema = z.object({
  name: z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  secretValue: z.string().min(1).max(65536).describe("The new secret value. This input is redacted from gateway summaries and never returned."),
}).strict();
const authConfigSchema = z.object({
  site_url: z.url().max(2048).optional(),
  uri_allow_list: z.string().max(10000).optional(),
  disable_signup: z.boolean().optional(),
  external_email_enabled: z.boolean().optional(),
  mailer_autoconfirm: z.boolean().optional(),
  jwt_exp: z.number().int().min(300).max(604800).optional(),
  password_min_length: z.number().int().min(6).max(128).optional(),
}).strict();
const apiConfigSchema = z.object({
  db_schema: z.string().min(1).max(2048).optional(),
  db_extra_search_path: z.string().max(2048).optional(),
  max_rows: z.number().int().min(1).max(1000000).optional(),
  db_pool: z.number().int().min(1).max(1000).optional(),
  db_pool_acquisition_timeout: z.number().int().min(1).max(600).optional(),
}).strict();
const deploySchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100).optional(),
  entrypoint_path: sourcePathSchema,
  import_map_path: sourcePathSchema.optional(),
  verify_jwt: z.boolean().default(true),
  files: z.array(z.object({ name: sourcePathSchema, content: z.string().max(MAX_BYTES) }).strict()).min(1).max(50),
}).strict();
type Risk = "read" | "write" | "destructive";
const operations = [
  { name: "supabase_get_project", title: "Get project", description: "Read details of the connection's Supabase project.", risk: "read", schema: emptySchema },
  { name: "supabase_get_auth_config", title: "Get Auth configuration", description: "Read site URL, redirect allow list, signup and password settings. Provider secrets are omitted.", risk: "read", schema: emptySchema },
  { name: "supabase_update_auth_config", title: "Update Auth configuration", description: "Change site URL, redirects, signup and password settings. Disabling confirmation or signup affects application access. Configure SMTP and OAuth secrets in the Supabase Dashboard.", risk: "write", schema: z.object({ config: authConfigSchema }).strict() },
  { name: "supabase_get_api_config", title: "Get Data API configuration", description: "Read exposed Postgres schemas, search path, row and connection limits. Signing secrets are omitted.", risk: "read", schema: emptySchema },
  { name: "supabase_update_api_config", title: "Update Data API configuration", description: "Change exposed Postgres schemas, search path, row and connection limits. Schema exposure remains subject to database permissions and RLS.", risk: "write", schema: z.object({ config: apiConfigSchema }).strict() },
  { name: "supabase_list_edge_functions", title: "List Edge Functions", description: "List deployed Edge Functions in the connection's project.", risk: "read", schema: emptySchema },
  { name: "supabase_get_edge_function", title: "Get Edge Function", description: "Read deployment status and configuration for an Edge Function.", risk: "read", schema: functionSchema },
  { name: "supabase_deploy_edge_function", title: "Deploy Edge Function", description: "Create or replace an Edge Function from supplied UTF-8 source files. Include the entrypoint and optional import map among files. JWT verification defaults on. This replaces the existing function with the same slug; inspect its state before retrying an uncertain result.", risk: "write", schema: deploySchema },
  { name: "supabase_delete_edge_function", title: "Delete Edge Function", description: "Permanently remove the named Edge Function from the connection's project.", risk: "destructive", schema: functionSchema },
  { name: "supabase_list_edge_function_secrets", title: "List Edge Function secret names", description: "List configured Edge Function secret names and update times. Secret values are never returned.", risk: "read", schema: emptySchema },
  { name: "supabase_upsert_edge_function_secret", title: "Set Edge Function secret", description: "Create or replace one Edge Function environment secret. Existing functions use the new value. The value is never returned. Use the Supabase Dashboard when a human must enter a credential privately.", risk: "write", schema: secretSchema },
] satisfies Array<{ name: string; title: string; description: string; risk: Risk; schema: z.ZodType }>;

export const SUPABASE_TOOLS = operations.map(({ name, title, description, risk, schema }) => ({
  name, title, description, inputSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
  annotations: { readOnlyHint: risk === "read", destructiveHint: risk === "destructive", idempotentHint: risk === "read", openWorldHint: true },
}));
export function supabaseRisk(name: string): Risk {
  return operations.find(operation => operation.name === name)?.risk ?? "destructive";
}
export function isSupabaseConnection(connection: { transport: string; config?: Record<string, unknown> }) {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === "supabase"
    && connection.config.connectionMethodKey === SUPABASE_METHOD && connection.config.url === SUPABASE_API_URL;
}
const contracts = new Map(SUPABASE_TOOLS.map(tool => [tool.name, {
  versionHash: descriptorHash(tool, supabaseRisk(tool.name)), schemaHash: stableHash(tool.inputSchema), riskLevel: supabaseRisk(tool.name),
}]));
export function isCurrentSupabaseCatalogEntry(entry: { toolName: string; versionHash: string; schemaHash: string | null; riskLevel: string }) {
  const current = contracts.get(entry.toolName);
  return Boolean(current && current.versionHash === entry.versionHash && current.schemaHash === entry.schemaHash && current.riskLevel === entry.riskLevel);
}
const fail = (status: number, code: string, message: string) => new HttpError(status, message, { code });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const projectFields = ["id", "ref", "name", "organization_id", "organization_slug", "region", "status", "created_at"];
const functionFields = ["id", "slug", "name", "status", "version", "created_at", "updated_at", "verify_jwt", "import_map", "entrypoint_path", "import_map_path"];

/** The governed transport supplies a selected grant's headers and its guarded
 * HTTP request function. This provider never resolves credentials or host files. */
export function supabaseClient(headers: Record<string, string>, request: SupabaseRequest, projectRef: unknown,
  signal: AbortSignal = AbortSignal.timeout(30_000), deadlineAt: number = Date.now() + 30_000) {
  if (!projectRefSchema.safeParse(projectRef).success) throw fail(422, "supabase_project_invalid", "Reconnect Supabase with a valid project reference.");
  const authorization = new Headers(headers).get("Authorization");
  if (!authorization || !/^Bearer \S+$/.test(authorization)) throw fail(422, "supabase_credential_missing", "Reconnect Supabase with a personal access token.");
  const secret = authorization.slice(7);
  const base = `${SUPABASE_API_URL}/projects/${projectRef}`;
  const deadlineError = fail(504, "supabase_deadline_exceeded", "The Supabase action deadline expired. Inspect the provider state before retrying a write.");
  const outputLimitError = fail(502, "supabase_output_limit", "Supabase returned an oversized response.");
  const expired = () => deadlineError;
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    const remaining = deadlineAt - Date.now();
    if (signal.aborted || remaining <= 0) throw expired();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (signal.aborted || Date.now() >= deadlineAt) throw expired(); return work(); }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(expired());
          signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(abort, remaining);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  function sanitize(value: unknown): unknown {
    if (typeof value === "string") return redactSensitiveText(value.split(secret).join("[REDACTED]"));
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSensitiveText(key.split(secret).join("[REDACTED]")), sanitize(item)]));
    return value;
  }
  // Auth and PostgREST responses can include secrets. Positive field selection
  // happens before the result reaches gateway/audit serialization.
  function select(value: unknown, fields: readonly string[]) {
    const data = record(value);
    return sanitize(Object.fromEntries(fields.filter(key => data[key] === null
      || ["string", "number", "boolean"].includes(typeof data[key])).map(key => [key, data[key]])));
  }
  async function send(path: string, method = "GET", body?: BodyInit, contentType?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await bounded(() => request(base + path, {
        method, body, redirect: "error", signal,
        headers: { Authorization: authorization!, Accept: "application/json", ...(contentType ? { "Content-Type": contentType } : {}) },
      }));
    } catch (error) {
      // The local timer is authoritative even if wall-clock time moved back or
      // the timer fired just before Date.now() reaches the absolute deadline.
      if (error === deadlineError || signal.aborted || Date.now() >= deadlineAt) throw expired();
      throw fail(502, "supabase_outcome_unknown", method === "GET" ? "Supabase could not complete this request." : "Supabase did not return a result. The operation may have completed; inspect its state before retrying.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      // Configuration may be applied before the provider reports a restart
      // failure. A server error is not proof that a write had no effect.
      if (method !== "GET" && (response.status >= 500 || response.status === 408)) {
        throw fail(502, "supabase_outcome_unknown", "Supabase reported an error after this write. The operation may have completed; inspect its state before retrying.");
      }
      const status = [400, 401, 402, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
      throw fail(status, "supabase_request_failed", status === 401 || status === 403
        ? "Supabase denied access. Reconnect with a personal access token authorized for this project and action."
        : status === 402 ? "Supabase requires an account or billing change for this operation."
        : status === 429 ? "Supabase rate limited this request. Wait before retrying."
        : status === 404 ? "Supabase could not find this project or function." : "Supabase could not complete this operation.");
    }
    if (response.status === 204 || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await bounded(() => reader.read());
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw outputLimitError;
        chunks.push(part.value);
      }
    } catch (error) {
      if (error === deadlineError || error === outputLimitError) throw error;
      throw fail(502, "supabase_outcome_unknown", "Supabase's response was interrupted. Inspect the operation before retrying.");
    } finally { void reader.cancel().catch(() => {}); }
    if (!size) return null;
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw fail(502, "supabase_invalid_response", "Supabase returned an invalid response."); }
  }
  async function invoke(name: string, parameters: unknown): Promise<unknown> {
    const operation = operations.find(candidate => candidate.name === name);
    if (!operation) throw fail(404, "supabase_tool_not_found", "Supabase action not found.");
    const parsed = operation.schema.safeParse(parameters);
    if (!parsed.success) throw fail(422, "supabase_arguments_invalid", "Invalid Supabase action arguments.");
    const args = record(parsed.data);
    switch (name) {
      case "supabase_get_project": return select(await send(""), projectFields);
      case "supabase_get_auth_config": return select(await send("/config/auth"), Object.keys(authConfigSchema.shape));
      case "supabase_get_api_config": return select(await send("/postgrest"), Object.keys(apiConfigSchema.shape));
      case "supabase_update_auth_config":
      case "supabase_update_api_config": {
        if (!Object.keys(record(args.config)).length) throw fail(422, "supabase_arguments_invalid", "Provide at least one configuration field.");
        const auth = name === "supabase_update_auth_config";
        const response = await send(auth ? "/config/auth" : "/postgrest", "PATCH", JSON.stringify(args.config), "application/json");
        return select(response, Object.keys(auth ? authConfigSchema.shape : apiConfigSchema.shape));
      }
      case "supabase_list_edge_functions": {
        const response = await send("/functions");
        if (!Array.isArray(response)) throw fail(502, "supabase_invalid_response", "Supabase returned an invalid function list.");
        return response.map(item => select(item, functionFields));
      }
      case "supabase_get_edge_function": return select(await send(`/functions/${args.slug}`), functionFields);
      case "supabase_delete_edge_function": {
        await send(`/functions/${args.slug}`, "DELETE");
        return { deleted: true, slug: args.slug };
      }
      case "supabase_list_edge_function_secrets": {
        const response = await send("/secrets");
        if (!Array.isArray(response)) throw fail(502, "supabase_invalid_response", "Supabase returned an invalid secret list.");
        // The API's field is named `value`; do not assume that it is a digest
        // or expose it if the provider ever changes the response contract.
        return response.map(item => select(item, ["name", "updated_at"]));
      }
      case "supabase_upsert_edge_function_secret": {
        const input = parsed.data as z.infer<typeof secretSchema>;
        await send("/secrets", "POST", JSON.stringify([{ name: input.name, value: input.secretValue }]), "application/json");
        // Do not trust an upstream echo, even in fields that appear harmless.
        return { configured: true, name: sanitize(input.name.split(input.secretValue).join("[REDACTED]")) };
      }
      case "supabase_deploy_edge_function": {
        const deployment = parsed.data as z.infer<typeof deploySchema>;
        const names = new Set(deployment.files.map(file => file.name));
        if (names.size !== deployment.files.length || !names.has(deployment.entrypoint_path)
          || (deployment.import_map_path && !names.has(deployment.import_map_path))) {
          throw fail(422, "supabase_files_invalid", "Provide unique source files including the entrypoint and optional import map.");
        }
        if (deployment.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > MAX_BYTES) {
          throw fail(422, "supabase_input_limit", "Supabase source files exceed the upload limit.");
        }
        const form = new FormData();
        form.append("metadata", JSON.stringify({ name: deployment.name ?? deployment.slug, entrypoint_path: deployment.entrypoint_path,
          ...(deployment.import_map_path ? { import_map_path: deployment.import_map_path } : {}), verify_jwt: deployment.verify_jwt }));
        for (const file of deployment.files) form.append("file", new Blob([file.content], { type: "application/octet-stream" }), file.name);
        // The guarded, DNS-pinned HTTP transport accepts bytes, not FormData.
        const encoded = new Request(SUPABASE_API_URL, { method: "POST", body: form });
        const bytes = Buffer.from(await bounded(() => encoded.arrayBuffer()));
        if (bytes.byteLength > MAX_BYTES) throw fail(422, "supabase_input_limit", "Supabase source files exceed the upload limit.");
        return select(await send(`/functions/deploy?slug=${deployment.slug}`, "POST", bytes, encoded.headers.get("Content-Type")!), functionFields);
      }
    }
    throw fail(404, "supabase_tool_not_found", "Supabase action not found.");
  }
  return { invoke, probe: () => invoke("supabase_get_project", {}) };
}
