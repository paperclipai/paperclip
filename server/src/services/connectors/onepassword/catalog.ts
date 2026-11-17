import { z } from "zod";
import { badRequest } from "../../../errors.js";
import { descriptorHash, stableHash } from "../../tool-catalog-hash.js";

export const ONEPASSWORD_METHOD = "service-account";
export const ONEPASSWORD_URL = "https://my.1password.com/";
export function isOnePasswordConnection(connection: { transport: string; config?: Record<string, unknown> }) {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === "1password"
    && connection.config.connectionMethodKey === ONEPASSWORD_METHOD && connection.config.url === ONEPASSWORD_URL;
}

const id = z.string().regex(/^[a-z0-9]{26}$/i);
const text = z.string().max(32_768);
const field = z.object({
  id: z.string().min(1).max(128), title: z.string().max(256), value: text,
  fieldType: z.enum(["Text", "Concealed", "Totp", "Url", "Email"]),
}).strict();
const itemChanges = {
  title: z.string().min(1).max(1024).optional(), notes: text.optional(),
  fields: z.array(field).max(100).optional(), tags: z.array(z.string().max(128)).max(50).optional(),
};
const target = { vaultId: id, itemId: id };
const operations = [
  { name: "onepassword_list_vaults", description: "List vaults accessible to this service account.", risk: "read", schema: z.object({}).strict() },
  { name: "onepassword_list_items", description: "List item summaries in an accessible vault, without secret field values.", risk: "read", schema: z.object({ vaultId: id }).strict() },
  { name: "onepassword_get_item", description: "Read an item, including its secret fields, from an accessible vault.", risk: "read", schema: z.object(target).strict() },
  { name: "onepassword_resolve_secret", description: "Resolve one op://vault/item/field reference. Returns the requested secret to the agent.", risk: "read", schema: z.object({ reference: z.string().min(8).max(2048).regex(/^op:\/\/[^\s]+$/) }).strict() },
  { name: "onepassword_create_item", description: "Create a Login, Password, API Credentials, or Secure Note item in an accessible vault.", risk: "write", schema: z.object({ ...itemChanges, vaultId: id, title: z.string().min(1).max(1024), category: z.enum(["Login", "Password", "ApiCredentials", "SecureNote"]) }).strict() },
  { name: "onepassword_update_item", description: "Update specified item properties. Supplied fields and tags replace their existing arrays; omitted properties are preserved.", risk: "write", schema: z.object({ ...target, ...itemChanges }).strict() },
  { name: "onepassword_archive_item", description: "Archive an item in an accessible vault.", risk: "destructive", schema: z.object(target).strict() },
  { name: "onepassword_delete_item", description: "Delete an item from an accessible vault.", risk: "destructive", schema: z.object(target).strict() },
] as const;

export const ONEPASSWORD_TOOLS = operations.map(({ name, description, risk, schema }) => ({
  name, title: name, description, inputSchema: z.toJSONSchema(schema),
  annotations: { readOnlyHint: risk === "read", destructiveHint: risk === "destructive", idempotentHint: risk === "read", openWorldHint: true },
}));

export function onePasswordRisk(name: string): "read" | "write" | "destructive" {
  return operations.find(operation => operation.name === name)?.risk ?? "destructive";
}

const contracts = new Map<string, { versionHash: string; schemaHash: string; riskLevel: "read" | "write" | "destructive" }>(ONEPASSWORD_TOOLS.map(tool => [tool.name, {
  versionHash: descriptorHash(tool, onePasswordRisk(tool.name)), schemaHash: stableHash(tool.inputSchema), riskLevel: onePasswordRisk(tool.name),
}]));
export const isOnePasswordToolName = (name: string) => contracts.has(name);
export function isCurrentOnePasswordEntry(entry: { toolName: string; versionHash: string; schemaHash: string | null; riskLevel: string }) {
  const current = contracts.get(entry.toolName);
  return Boolean(current && current.versionHash === entry.versionHash && current.schemaHash === entry.schemaHash && current.riskLevel === entry.riskLevel);
}

export function onePasswordArguments(tool: string, parameters: unknown): Record<string, unknown> {
  const operation = operations.find(entry => entry.name === tool);
  const parsed = operation?.schema.safeParse(parameters);
  if (!parsed?.success || JSON.stringify(parameters).length > 64 * 1024) {
    throw badRequest("Invalid 1Password action arguments", { code: "onepassword_arguments_invalid" });
  }
  if (tool === "onepassword_update_item" && !Object.keys(itemChanges).some(key => key in parsed.data)) {
    throw badRequest("Specify at least one item property to update", { code: "onepassword_arguments_invalid" });
  }
  return parsed.data;
}
