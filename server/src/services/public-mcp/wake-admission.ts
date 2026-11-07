import { mcpClientMirrorReceiptSchema, type McpClientMirrorReceipt } from "./client-mirror-contract.js";
import { parseMcpDiscovery, type McpDiscovery } from "./discovery.js";
import { parseMcpRevocationIndexReceipt, type McpRevocationIndexReceipt } from "./revocation-index-contract.js";
import { createHash } from "node:crypto";
import {
  apiWakeFingerprint, createApiWakeAdmission,
} from "../idle-api-wake-admission.js";

export const mcpWakeProfiles = ["personal-mcp", "dot-mcp"] as const;
export type McpWakeProfile = typeof mcpWakeProfiles[number];
export type McpWakeTokenKind = "access" | "refresh";
export interface McpWakeClaim {
  generation: string;
  fingerprint: string;
  profile: McpWakeProfile;
  tokenKind: McpWakeTokenKind;
}
export interface McpWakeAdmission {
  version: 1;
  absent?:true;
  stackId: string;
  ownerId: string;
  capabilityGeneration: string;
  challenge: string;
  generation: string;
  revocationAuthorities: McpRevocationIndexReceipt[];
  clientMirror?: McpClientMirrorReceipt;
  discovery?: McpDiscovery;
  lanes: { profile: McpWakeProfile; tokenKind: McpWakeTokenKind; keys: { fingerprint: string; expiresAt: string | null }[] }[];
}
type Context = Pick<McpWakeAdmission, "stackId" | "ownerId" | "capabilityGeneration" | "challenge">;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && Object.keys(v).every(key => keys.includes(key));
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const laneChallenge = (context: Context, profile: McpWakeProfile, kind: McpWakeTokenKind) =>
  hash(["paperclip-mcp-oauth-wake-v1", context.stackId, context.ownerId, context.challenge, profile, kind]);
const generation = (value: Omit<McpWakeAdmission, "generation">) =>
  hash(["paperclip-mcp-oauth-wake-receipt-v1", value.version, value.stackId, value.ownerId,
    value.capabilityGeneration, value.challenge, value.lanes, value.revocationAuthorities, ...(value.discovery ? [value.discovery] : []), ...(value.clientMirror ? [value.clientMirror] : []), ...(value.absent ? ["absent"] : [])]);



export function createMcpWakeAdmission(input: Context & {
  absent?:true;
  revocationAuthorities?: McpRevocationIndexReceipt[];
  clientMirror?: McpClientMirrorReceipt;
  discovery?: McpDiscovery;
  tokens: { profile: McpWakeProfile; tokenKind: McpWakeTokenKind; tokenHash: string; expiresAt: string | null; clientId?: string }[];
}): McpWakeAdmission {
  const { tokens, revocationAuthorities = [], discovery, clientMirror, absent, ...context } = input;
  if (tokens.length > 1000) throw new Error("Too many MCP wake credentials");
  const lanes: McpWakeAdmission["lanes"] = [];
  for (const profile of mcpWakeProfiles) for (const tokenKind of ["access", "refresh"] as const) {
    const selected = tokens.filter(token => token.profile === profile && token.tokenKind === tokenKind);
    if (!selected.length) continue;
    if (selected.some(token => token.expiresAt === null && !(profile === "dot-mcp" && tokenKind === "refresh"))) {
      throw new Error("Only Dot refresh credentials can have unbounded inactivity");
    }
    const challenge = laneChallenge(context, profile, tokenKind);

    const keys = selected.map(token => {
      if (!digest(token.tokenHash)) throw new Error("Invalid MCP wake credential hash");
      if (tokenKind === "refresh" && (!token.clientId || token.clientId.length > 2048)) throw new Error("MCP refresh client is required");
      const keyHash = tokenKind === "refresh" ? hash(["paperclip-mcp-refresh-client-v1", token.tokenHash, token.clientId]) : token.tokenHash;
      return { fingerprint: apiWakeFingerprint({ ...context, challenge, keyHash }), expiresAt: token.expiresAt };
    });
    lanes.push({ profile, tokenKind, keys: createApiWakeAdmission({ ...context, challenge, keys }).keys });
  }
  const receipt = { version: 1 as const, ...context,...(absent?{absent}:{}), lanes, revocationAuthorities: [...revocationAuthorities].sort((a,b) => a.authorityId.localeCompare(b.authorityId)), ...(discovery ? { discovery: parseMcpDiscovery(discovery) } : {}), ...(clientMirror ? {clientMirror:mcpClientMirrorReceiptSchema.parse(clientMirror)} : {}) };
  return parseMcpWakeAdmission({ ...receipt, generation: generation(receipt) });
}

export function parseMcpWakeAdmission(value: unknown): McpWakeAdmission {
  if (!object(value) || !exact(value, ["version", "stackId", "ownerId", "capabilityGeneration", "challenge", "generation", "lanes", "revocationAuthorities", ...(object(value) && "discovery" in value ? ["discovery"] : []), ...(object(value) && "clientMirror" in value ? ["clientMirror"] : []), ...(object(value) && "absent" in value ? ["absent"] : [])])
    || value.version !== 1 || !digest(value.challenge) || !digest(value.capabilityGeneration) || !digest(value.generation)
    || !Array.isArray(value.lanes) || value.lanes.length > 4 || !Array.isArray(value.revocationAuthorities) || value.revocationAuthorities.length > 1000) throw new Error("Invalid MCP wake receipt");
  const context = { stackId: value.stackId, ownerId: value.ownerId, capabilityGeneration: value.capabilityGeneration, challenge: value.challenge } as Context;

  createApiWakeAdmission({ ...context, keys: [] });
  let previous = "", total = 0;
  const lanes = value.lanes.map(lane => {
    if (!object(lane) || !exact(lane, ["profile", "tokenKind", "keys"])
      || !mcpWakeProfiles.includes(lane.profile as McpWakeProfile) || !["access", "refresh"].includes(String(lane.tokenKind))) throw new Error("Invalid MCP wake lane");
    const profile = lane.profile as McpWakeProfile, tokenKind = lane.tokenKind as McpWakeTokenKind;
    const order = `${mcpWakeProfiles.indexOf(profile)}:${tokenKind}`;
    if (order <= previous) throw new Error("MCP wake lanes must be canonical and unique");
    previous = order;
    if (!Array.isArray(lane.keys)) throw new Error("Invalid MCP wake credentials");
    const keys = createApiWakeAdmission({ ...context, challenge: laneChallenge(context, profile, tokenKind),
      keys: lane.keys as McpWakeAdmission["lanes"][number]["keys"] }).keys;
    total += keys.length;
    if (!keys.length || total > 1000 || JSON.stringify(keys) !== JSON.stringify(lane.keys)
      || keys.some(key => key.expiresAt === null && !(profile === "dot-mcp" && tokenKind === "refresh"))) throw new Error("MCP wake lane changed");
    return { profile, tokenKind, keys };
  });
  let previousAuthority = "";
  const revocationAuthorities = value.revocationAuthorities.map(authority => {
    const parsed = parseMcpRevocationIndexReceipt(authority);
    if (parsed.authorityId <= previousAuthority) throw new Error("MCP revocation authorities must be canonical and unique");
    previousAuthority = parsed.authorityId; return parsed;
  });
  if("absent" in value&&(value.absent!==true||lanes.length||revocationAuthorities.length||"discovery"in value||"clientMirror"in value))throw new Error("Absent MCP admission contains authority");
  const parsed = { version: 1 as const,...("absent"in value?{absent:true as const}:{}), stackId: context.stackId, ownerId: context.ownerId,
    capabilityGeneration: context.capabilityGeneration, challenge: context.challenge, generation: value.generation, lanes, revocationAuthorities, ...("discovery" in value ? { discovery: parseMcpDiscovery(value.discovery) } : {}), ...("clientMirror" in value ? {clientMirror:mcpClientMirrorReceiptSchema.parse(value.clientMirror)} : {}) };
  if (generation(parsed) !== parsed.generation) throw new Error("MCP wake receipt generation changed");
  return parsed;
}


export function authorizeMcpWakeAdmission(receipt: McpWakeAdmission, input: {
  stackId: string; token: string; now: number; profile: McpWakeProfile; tokenKind: McpWakeTokenKind; clientId?: string; operation?: "use" | "revoke";
}): McpWakeClaim | undefined {
  if (input.operation === "revoke" || !Number.isFinite(input.now) || receipt.stackId !== input.stackId) return;
  const lane = receipt.lanes.find(lane => lane.profile === input.profile && lane.tokenKind === input.tokenKind);
  if (!lane || !input.token || input.token.length > 8192 || /\s/.test(input.token)) return;
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  if (input.tokenKind === "refresh" && (!input.clientId || input.clientId.length > 2048)) return;
  const keyHash = input.tokenKind === "refresh" ? hash(["paperclip-mcp-refresh-client-v1", tokenHash, input.clientId]) : tokenHash;
  const fingerprint = apiWakeFingerprint({ ...receipt, challenge: laneChallenge(receipt, input.profile, input.tokenKind), keyHash });
  return lane.keys.some(key => key.fingerprint === fingerprint && (key.expiresAt === null || Date.parse(key.expiresAt) > input.now))
    ? { generation: receipt.generation, fingerprint, profile: input.profile, tokenKind: input.tokenKind } : undefined;
}


export function matchesMcpWakeClaim(receipt: McpWakeAdmission, claim: McpWakeClaim, now: number): boolean {
  return Number.isFinite(now) && receipt.generation === claim.generation && receipt.lanes.some(lane =>
    lane.profile === claim.profile && lane.tokenKind === claim.tokenKind && lane.keys.some(key =>
      key.fingerprint === claim.fingerprint && (key.expiresAt === null || Date.parse(key.expiresAt) > now)));
}
