import { mcpClientMirrorPageFits } from "./client-mirror-wire.js";
import { mcpDeviceStatusReferenceSchema,mcpDeviceStatusEntrySchema } from "./device-status-contract.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validMcpRedirect } from "./client-metadata.js";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const origin = z.string().url().max(2048).refine(value => { const url = new URL(value); return url.protocol === "https:" && url.origin === value; });
const identifier = z.string().min(1).max(2048);
export const mcpMirroredClientSchema = z.object({ id: identifier, name: z.string().min(1).max(100),
  redirectUris: z.array(z.string().max(2048).refine(validMcpRedirect)).max(10),
  grantTypes: z.array(z.enum(["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"])).transform(values=>[...new Set(values)]),
}).strict();
const change = z.discriminatedUnion("operation", [z.object({ operation: z.literal("upsert"), client: mcpMirroredClientSchema }).strict(),
  z.object({ operation: z.literal("delete"), clientId: identifier }).strict()]);
const identity = z.object({ version: z.literal(1), instanceId: z.string().min(1).max(200), origin, revision,authorizationOrigin:origin.optional(),
  deviceStatus:mcpDeviceStatusReferenceSchema.optional(),baseRevision: revision.nullable(), expectedRecords: revision });
export const mcpClientMirrorRequestSchema = z.discriminatedUnion("operation", [
  identity.extend({ operation: z.literal("begin"),deviceKey:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict(),
  identity.extend({ operation: z.literal("disable") }).strict(),
  identity.extend({ operation: z.literal("append"), sequence: revision, changes: z.array(change).min(1).max(200) }).strict(),
  identity.extend({ operation: z.literal("append-device-status"),sequence:revision,entries:z.array(mcpDeviceStatusEntrySchema).min(1).max(200) }).strict(),
  identity.extend({ operation: z.literal("complete") }).strict(),
]).refine(mcpClientMirrorPageFits,"MCP client mirror page is too large");
export const mcpClientMirrorReceiptSchema = z.object({ version: z.literal(1), instanceId: z.string().min(1).max(200), origin, revision,authorizationOrigin:origin.optional(),
  deviceStatus:mcpDeviceStatusReferenceSchema.optional(),frontDoor:z.literal("tenant-personal-v1").optional(),enabled:z.boolean(),generation: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const mcpClientMirrorResponseSchema = z.discriminatedUnion("complete", [
  z.object({ complete: z.literal(true), receipt: mcpClientMirrorReceiptSchema }).strict(),
  z.object({ complete: z.literal(false), nextSequence: revision, receivedRecords: revision,nextDeviceSequence:revision.optional() }).strict(),
]);
export type McpMirroredClient = z.infer<typeof mcpMirroredClientSchema>;
export type McpClientMirrorChange = z.infer<typeof change>;
export type McpClientMirrorRequest = z.infer<typeof mcpClientMirrorRequestSchema>;
export type McpClientMirrorReceipt = z.infer<typeof mcpClientMirrorReceiptSchema>;
export type McpClientMirrorResponse = z.infer<typeof mcpClientMirrorResponseSchema>;
export function mcpClientMirrorGeneration(value: Pick<McpClientMirrorRequest,"instanceId"|"origin"|"revision">&{enabled?:boolean;frontDoor?:"tenant-personal-v1";authorizationOrigin?:string;deviceStatus?:z.infer<typeof mcpDeviceStatusReferenceSchema>}) {
  return createHash("sha256").update(JSON.stringify(["mcp-client-mirror-v1",value.instanceId,value.origin,value.revision,value.enabled??true,value.frontDoor??null,value.deviceStatus??null,value.authorizationOrigin??value.origin])).digest("hex");
}
export function mcpClientMirrorPageHash(changes: McpClientMirrorChange[]) {
  return createHash("sha256").update(JSON.stringify(changes)).digest("hex");
}
