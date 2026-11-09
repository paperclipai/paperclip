import { createHash, createHmac } from "node:crypto";

export interface McpRevocationIndexReceipt {
  version: 1;
  authorityId: string;
  keyId: string;
  revision: number;
  generation: string;
}
export interface McpRevocationIndexIdentity {
  authorityId: string;
  companyId: string;
  operatorId: string;
  clientId: string;
  resource: string;
  keyId: string;
  revision: number;
}
export type McpRevocationIndexRequest = McpRevocationIndexIdentity & (
  | { operation: "begin"; key: string }
  | { operation: "append"; entries: { fingerprint: string; tokenKind: "access" | "refresh" }[] }
  | { operation: "complete" }
);
export type McpRevocationIndexResponse = { complete: false; baseRevision: number } | { complete: true; receipt: McpRevocationIndexReceipt };
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function mcpRevocationAuthorityId(grantId: string, keyId: string): string {
  const hex = createHash("sha256").update(JSON.stringify(["paperclip-mcp-revoke-authority-v1", grantId, keyId])).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function mcpRevocationKeyId(key: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, "base64url").length !== 32) throw new Error("Invalid MCP revocation key");
  return createHash("sha256").update(Buffer.from(key, "base64url")).digest("hex");
}


export function mcpRevocationFingerprint(key: string, tokenHash: string, clientId: string, resource: string): string {
  mcpRevocationKeyId(key);
  if (!digest(tokenHash)) throw new Error("Invalid MCP revocation token hash");
  return createHmac("sha256", Buffer.from(key, "base64url"))
    .update(JSON.stringify(["paperclip-dot-revoke-index-v1", tokenHash, clientId, resource])).digest("hex");
}
export function parseMcpRevocationIndexReceipt(value: unknown): McpRevocationIndexReceipt {
  if (!object(value) || Object.keys(value).sort().join() !== "authorityId,generation,keyId,revision,version"
    || value.version !== 1 || !uuid(value.authorityId) || !digest(value.keyId) || !digest(value.generation)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error("Invalid MCP revocation receipt");
  return { version: 1, authorityId: value.authorityId, keyId: value.keyId, revision: Number(value.revision), generation: value.generation };
}
export function parseMcpRevocationIndexRequest(value: unknown): McpRevocationIndexRequest {
  if (!object(value) || !uuid(value.authorityId) || !uuid(value.companyId)
    || typeof value.operatorId !== "string" || !value.operatorId || value.operatorId.length > 200
    || typeof value.clientId !== "string" || !value.clientId || value.clientId.length > 2048
    || typeof value.resource !== "string" || value.resource.length > 2048
    || !digest(value.keyId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error("Invalid MCP revocation identity");
  const url = new URL(value.resource);
  if (url.protocol !== "https:" || !["/mcp/runner", "/mcp/paperclip"].includes(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error("Invalid MCP revocation resource");
  const common = ["authorityId", "companyId", "operatorId", "clientId", "resource", "keyId", "revision", "operation"];
  const fields = value.operation === "begin" ? ["key"] : value.operation === "append" ? ["entries"] : value.operation === "complete" ? [] : undefined;
  if (!fields || Object.keys(value).some(key => ![...common, ...fields].includes(key))) throw new Error("Unknown MCP revocation operation");
  if (value.operation === "begin" && (typeof value.key !== "string" || mcpRevocationKeyId(value.key) !== value.keyId)) throw new Error("MCP revocation key changed");
  if (value.operation === "append" && (!Array.isArray(value.entries) || !value.entries.length || value.entries.length > 200 || value.entries.some(entry =>
    !object(entry) || Object.keys(entry).sort().join() !== "fingerprint,tokenKind" || !digest(entry.fingerprint) || !["access", "refresh"].includes(String(entry.tokenKind))))) throw new Error("Invalid MCP revocation page");
  return value as unknown as McpRevocationIndexRequest;
}
