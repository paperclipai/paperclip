import { z } from "zod";
import { descriptorHash, stableHash } from "../../tool-catalog-hash.js";

export const AZURE_DEVOPS_API_URL = "https://dev.azure.com";
export const AZURE_DEVOPS_ENTRA_METHOD = "entra";
export const AZURE_DEVOPS_PAT_METHOD = "pat";
export const AZURE_DEVOPS_TOOLS = [{
  name: "azure_devops_list_repositories",
  title: "List repositories",
  description: "List repositories in the connected Azure DevOps organization. Repository metadata only; no write actions are available.",
  inputSchema: z.toJSONSchema(z.object({}).strict()) as Record<string, unknown>,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}];
export function azureDevOpsRisk(name: string): "read" | "write" | "destructive" {
  return AZURE_DEVOPS_TOOLS.some(tool => tool.name === name) ? "read" : "destructive";
}
const contracts = new Map(AZURE_DEVOPS_TOOLS.map(tool => [tool.name, {
  versionHash: descriptorHash(tool, azureDevOpsRisk(tool.name)),
  schemaHash: stableHash(tool.inputSchema),
  riskLevel: azureDevOpsRisk(tool.name),
}]));
export function isCurrentAzureDevOpsCatalogEntry(entry: { toolName: string; versionHash: string; schemaHash: string | null; riskLevel: string }): boolean {
  const current = contracts.get(entry.toolName);
  return Boolean(current && current.versionHash === entry.versionHash && current.schemaHash === entry.schemaHash && current.riskLevel === entry.riskLevel);
}
