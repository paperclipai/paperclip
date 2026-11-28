const maxInteger = Number.MAX_SAFE_INTEGER;
const digest = "f".repeat(64);
const identity = {
  version: 1, instanceId: "", origin: "", revision: maxInteger,
  baseRevision: maxInteger, expectedRecords: maxInteger, authorizationOrigin: "",
  deviceStatus: { keyId: digest, generation: digest, count: 1000 },
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const bound = (value: unknown, variableUtf16Units: number) => bytes(value) + 6 * variableUtf16Units;
const identityUnits = 200 + 2048 + 2048;
export const MCP_MIRROR_NORMAL_PAGE_BYTES = 49_152;
export const MCP_MIRROR_MAX_JWS_CHARACTERS = 12_000;
export const MCP_MIRROR_SINGLE_RECORD_BYTES = Object.freeze({
  upsert: bound({ ...identity, operation: "append", sequence: maxInteger, changes: [{
    operation: "upsert", client: { id: "", name: "", redirectUris: Array(10).fill(""),
      grantTypes: Array(3).fill("urn:ietf:params:oauth:grant-type:device_code") },
  }] }, identityUnits + 2048 + 100 + 10 * 2048),
  delete: bound({ ...identity, operation: "append", sequence: maxInteger,
    changes: [{ operation: "delete", clientId: "" }] }, identityUnits + 2048),
  device: bound({ ...identity, operation: "append-device-status", sequence: maxInteger, entries: [{
    requestId: "00000000-0000-4000-8000-000000000000", fingerprint: digest,
    clientId: "", resource: "", ingressOwner: "tenant", status: "consumed", expiresAt: maxInteger,
  }] }, identityUnits + 2048 + 2048),
});
export const MCP_MIRROR_MAX_BINDING_BYTES = Math.max(MCP_MIRROR_NORMAL_PAGE_BYTES, ...Object.values(MCP_MIRROR_SINGLE_RECORD_BYTES));
export const MCP_MIRROR_MAX_ENVELOPE_BYTES = 2 * MCP_MIRROR_MAX_BINDING_BYTES
  + MCP_MIRROR_MAX_JWS_CHARACTERS + bytes({ request: "", binding: "" });
type Page = { operation: string; sequence?: number; changes?: { operation: string }[]; entries?: unknown[] };
export function mcpClientMirrorRequestByteLimit(value: Page): number {
  if (value.operation === "append" && value.changes?.length === 1) {
    if (value.changes[0]?.operation === "upsert") return Math.max(MCP_MIRROR_NORMAL_PAGE_BYTES, MCP_MIRROR_SINGLE_RECORD_BYTES.upsert);
    if (value.changes[0]?.operation === "delete") return Math.max(MCP_MIRROR_NORMAL_PAGE_BYTES, MCP_MIRROR_SINGLE_RECORD_BYTES.delete);
  }
  if (value.operation === "append-device-status" && value.entries?.length === 1) return Math.max(MCP_MIRROR_NORMAL_PAGE_BYTES, MCP_MIRROR_SINGLE_RECORD_BYTES.device);
  return MCP_MIRROR_NORMAL_PAGE_BYTES;
}
export function mcpClientMirrorPageFits(value: Page): boolean {
  return bytes(value) <= mcpClientMirrorRequestByteLimit(value);
}
export function assertMcpClientMirrorEnvelope(request: string, binding: string, encodedBody: string): void {
  if (request.length > MCP_MIRROR_MAX_JWS_CHARACTERS
    || Buffer.byteLength(binding, "utf8") > MCP_MIRROR_MAX_BINDING_BYTES
    || Buffer.byteLength(encodedBody, "utf8") > MCP_MIRROR_MAX_ENVELOPE_BYTES) {
    throw new Error("MCP client mirror signed envelope exceeds its bounded wire contract");
  }
}
