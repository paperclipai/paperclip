import { z } from "zod";
import { descriptorHash, stableHash } from "../../tool-catalog-hash.js";

export const VERCEL_API_URL = "https://api.vercel.com";
export const VERCEL_METHOD = "rest-api-key";
export const vercelTeamIdSchema = z.string().regex(/^team_[A-Za-z0-9]+$/).max(100);
const identifier = z.string().regex(/^[A-Za-z0-9_-]+$/).max(100);
const project = { projectId: identifier.describe("Vercel project ID or name in this connection's team.") };
const deployment = { ...project, deploymentId: identifier };
const domain = z.string().max(253).regex(/^(?:\*\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/);
const page = { limit: z.number().int().min(1).max(100).optional(), from: z.string().max(100).optional() };
const settings = z.object({
  framework: z.string().max(100).nullable().optional(),
  buildCommand: z.string().max(256).nullable().optional(),
  installCommand: z.string().max(256).nullable().optional(),
  devCommand: z.string().max(256).nullable().optional(),
  outputDirectory: z.string().max(256).nullable().optional(),
  rootDirectory: z.string().max(256).nullable().optional(),
  nodeVersion: z.string().max(30).optional(),
}).strict();

function operation(name: string, title: string, description: string, risk: "read" | "write" | "destructive", schema: z.ZodType) {
  return { name: `vercel_${name}`, title, description, risk, schema };
}

export const vercelOperations = [
  operation("list_projects", "List projects", "List projects in the connected Vercel team. Use pagination.next as from for another page.", "read", z.object(page).strict()),
  operation("get_project", "Get project", "Inspect project build configuration. Environment values and credentials are excluded.", "read", z.object(project).strict()),
  operation("create_project", "Create project", "Create a Vercel project in the connected team. Provider plan and usage charges apply.", "write", z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100), settings: settings.optional() }).strict()),
  operation("update_project", "Update project settings", "Change build/install commands, framework, directories or Node version for a project.", "write", z.object({ ...project, settings }).strict()),
  operation("delete_project", "Delete project", "Permanently delete a project and its deployments and configuration.", "destructive", z.object(project).strict()),
  operation("list_deployments", "List deployments", "List deployments of a project. Use pagination.next as until for another page.", "read", z.object({ ...project, limit: page.limit, until: z.number().int().nonnegative().optional() }).strict()),
  operation("get_deployment", "Get deployment", "Inspect a deployment's URL, state and error code. A queued deployment is not yet a successful deployment.", "read", z.object(deployment).strict()),
  operation("create_deployment", "Deploy project", "Deploy one source: inline files (up to 4 MiB total), a GitHub repository accessible to Vercel, or an existing deployment ID. Preview is the default and requires an existing undeleted deployment; failed or canceled deployments count. Vercel makes an empty project's first deployment production. Set target=production explicitly only when production is authorized. A reconciliationRequired receipt means preview was not confirmed; inspect that deployment before retrying.", "write", z.object({
    ...project, name: identifier, target: z.enum(["preview", "production"]).optional(),
    files: z.array(z.object({ file: z.string().min(1).max(500), content: z.string().max(4 * 1024 * 1024), encoding: z.enum(["utf-8", "base64"]).optional() }).strict()).min(1).max(500).optional(),
    gitSource: z.object({ type: z.literal("github"), repoId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]), ref: z.string().min(1).max(500) }).strict().optional(),
    deploymentId: identifier.optional(), projectSettings: settings.optional(),
  }).strict()),
  operation("cancel_deployment", "Cancel deployment", "Cancel an in-progress deployment in the selected project.", "destructive", z.object(deployment).strict()),
  operation("delete_deployment", "Delete deployment", "Permanently delete a deployment in the selected project.", "destructive", z.object(deployment).strict()),
  operation("list_environment_variables", "List environment variable names", "List environment variable metadata. Values are never returned and decryption is disabled.", "read", z.object(project).strict()),
  operation("upsert_environment_variable", "Set environment variable", "Create or replace an environment variable for explicit targets. secretValue is redacted in audit. Changes apply to new deployments. Encrypted is the default storage type; sensitive is write-only in Vercel and supports preview/production.", "write", z.object({
    ...project, key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256), secretValue: z.string().max(64 * 1024),
    target: z.array(z.enum(["preview", "production", "development"])).min(1).max(3),
    type: z.enum(["encrypted", "sensitive", "plain"]).optional(), gitBranch: z.string().min(1).max(500).optional(),
  }).strict()),
  operation("delete_environment_variable", "Delete environment variable", "Remove one environment variable using its ID from the metadata list.", "destructive", z.object({ ...project, environmentVariableId: identifier }).strict()),
  operation("list_domains", "List project domains", "List attached project domains and verification state. Use pagination.next as until for another page.", "read", z.object({ ...project, limit: page.limit, until: z.number().int().nonnegative().optional() }).strict()),
  operation("add_domain", "Add project domain", "Attach an already-owned domain and return required DNS verification records. This does not purchase a domain or change DNS.", "write", z.object({ ...project, domain, gitBranch: z.string().min(1).max(500).optional() }).strict()),
  operation("verify_domain", "Verify project domain", "Check DNS ownership after the required records are configured.", "write", z.object({ ...project, domain }).strict()),
  operation("remove_domain", "Remove project domain", "Remove a domain from a project, which can interrupt traffic to that domain.", "destructive", z.object({ ...project, domain }).strict()),
];

export const VERCEL_TOOLS = vercelOperations.map(({ name, title, description, risk, schema }) => ({
  name, title, description, inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
  annotations: { readOnlyHint: risk === "read", destructiveHint: risk === "destructive", openWorldHint: true },
}));
export function vercelRisk(name: string): "read" | "write" | "destructive" {
  return vercelOperations.find(operation => operation.name === name)?.risk ?? "destructive";
}
const currentContracts = new Map(VERCEL_TOOLS.map(tool => [tool.name, {
  versionHash: descriptorHash(tool, vercelRisk(tool.name)), schemaHash: stableHash(tool.inputSchema), riskLevel: vercelRisk(tool.name),
}]));
export function isCurrentVercelCatalogEntry(entry: { toolName: string; versionHash: string; schemaHash: string | null; riskLevel: string }): boolean {
  const current = currentContracts.get(entry.toolName);
  return Boolean(current && current.versionHash === entry.versionHash && current.schemaHash === entry.schemaHash && current.riskLevel === entry.riskLevel);
}
export function isVercelConnection(connection: { transport: string; config?: Record<string, unknown> }) {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === "vercel"
    && connection.config.connectionMethodKey === VERCEL_METHOD
    && (connection.config.url === VERCEL_API_URL || connection.config.url === `${VERCEL_API_URL}/`);
}
