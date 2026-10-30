export { parseNativeCursorCloudConfig, type NativeCursorCloudConfig } from "../../contracts/cursor-cloud.js";

export const CURSOR_CLOUD_MCP_SERVER_NAME = "paperclip" as const;

export interface CursorCloudBinding {
  companyId: string;
  agentId: string;
  issueId: string;
  normalizedSessionId: string;
}

export function cursorCloudRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cursor Cloud configuration must be an object");
  return value as Record<string, unknown>;
}

export function parseCursorCloudBinding(value: unknown): CursorCloudBinding {
  const source = cursorCloudRecord(value);
  if (Object.keys(source).sort().join(",") !== "agentId,companyId,issueId,normalizedSessionId"
    || !Object.values(source).every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(value))) throw new Error("Cursor Cloud binding is invalid");
  return { companyId: source.companyId as string, agentId: source.agentId as string, issueId: source.issueId as string, normalizedSessionId: source.normalizedSessionId as string };
}
