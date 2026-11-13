import type { McpClientMirrorReceipt } from "./client-mirror-contract.js";
import type { McpDiscovery } from "./discovery.js";
import { createHash } from "node:crypto";
import { PUBLIC_MCP_SCOPES, DOT_RUNNER_MCP_SCOPES } from "@paperclipai/shared";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, dotAgentBindings,
  mcpOauthGrants, mcpOauthTokens, type Db,
} from "@paperclipai/db";
import { mcpRevocationAuthorityId, parseMcpRevocationIndexReceipt, type McpRevocationIndexReceipt } from "./revocation-index-contract.js";
import { createMcpWakeAdmission, type McpWakeAdmission, type McpWakeProfile, type McpWakeTokenKind } from "./wake-admission.js";

export interface IdleMcpWakeProof {

  admission: McpWakeAdmission;
  generation: string;
  grantIds: string[];
  dotBindingIds: string[];
}
export interface IdleMcpCredentialRow {
  grantId: string;
  companyId: string;
  clientId: string;
  resource: string;
  purpose: string;
  scopes: string[];
  tokenHash: string;
  tokenKind: string;
  tokenExpiresAt: Date | null;
  tokenUsedAt: Date | null;
  dotBindingId: string | null;
  dotProvider: string | null;
  dotStatus: string | null;
  dotGeneration: number | null;
  dotPairingHash: string | null;
  dotChallengeHash: string | null;
  agentStatus: string | null;
  membershipRole: string | null;
}
export interface IdleMcpInspectionBudget { beforeRead(): Promise<void>; check(): void }
export interface IdleMcpWakeProofInput {
  budget?: IdleMcpInspectionBudget;
  clientMirror?: McpClientMirrorReceipt;
  discovery?: McpDiscovery;
  stackId: string;
  ownerId: string;
  capabilityGeneration: string;
  challenge: string;
  personalResource: string;
  dotResource: string;
  personalEnabled: boolean;
  dotEnabled: boolean;
  now: number;
}


export function projectIdleMcpWakeProof(rows: IdleMcpCredentialRow[], input: IdleMcpWakeProofInput): IdleMcpWakeProof {
  input.budget?.check();
  if (rows.length > 1000 || !Number.isFinite(input.now)) throw new Error("MCP wake inspection is incomplete");
  const tokens: { profile: McpWakeProfile; tokenKind: McpWakeTokenKind; tokenHash: string; expiresAt: string | null; clientId: string }[] = [];
  const grantIds = new Set<string>(), dotBindingIds = new Set<string>();
  for (const row of rows) {
    input.budget?.check();
    const personal = input.personalEnabled && row.resource === input.personalResource && row.purpose === "personal"
      && row.scopes.includes("paperclip:read") && row.scopes.every(scope => (PUBLIC_MCP_SCOPES as readonly string[]).includes(scope));
    const dot = input.dotEnabled && row.resource === input.dotResource && row.purpose === "agent"
      && row.scopes.includes("paperclip:agent") && row.scopes.every(scope => (DOT_RUNNER_MCP_SCOPES as readonly string[]).includes(scope)) && row.membershipRole !== "viewer"
      && row.dotProvider === "openai_dot" && ["connected", "ready"].includes(row.dotStatus ?? "")
      && row.dotBindingId !== null && row.dotGeneration !== null && Number.isSafeInteger(row.dotGeneration) && row.dotGeneration > 0
      && row.dotPairingHash === null && row.dotChallengeHash === null
      && row.agentStatus !== null && !["terminated", "pending_approval"].includes(row.agentStatus);
    if (!personal && !dot) continue;
    if (row.tokenKind !== "access" && row.tokenKind !== "refresh") throw new Error("Unknown MCP credential kind");
    if (row.tokenKind === "refresh" && row.tokenUsedAt !== null) continue;
    if (row.tokenExpiresAt === null ? !dot || row.tokenKind !== "refresh" : row.tokenExpiresAt.getTime() <= input.now) continue;
    tokens.push({ profile: personal ? "personal-mcp" : "dot-mcp", tokenKind: row.tokenKind,
      tokenHash: row.tokenHash, expiresAt: row.tokenExpiresAt?.toISOString() ?? null, clientId: row.clientId });
    grantIds.add(row.grantId);
    if (dot) dotBindingIds.add(row.dotBindingId!);
  }
  const admission = createMcpWakeAdmission({ stackId: input.stackId, ownerId: input.ownerId,
    capabilityGeneration: input.capabilityGeneration, challenge: input.challenge, tokens, discovery: input.discovery, clientMirror: input.clientMirror,...(!input.personalEnabled&&!input.dotEnabled?{absent:true as const}:{}) });
  return { admission, generation: createHash("sha256").update(JSON.stringify([admission.generation, rows.map(({ tokenHash: _private, ...row }) => row)])).digest("hex"),
    grantIds: [...grantIds].sort(), dotBindingIds: [...dotBindingIds].sort() };
}




export async function readIdleMcpWakeProof(tx: Pick<Db, "select">, input: IdleMcpWakeProofInput): Promise<IdleMcpWakeProof> {
  await input.budget?.beforeRead();
  const rows = await tx.select({
    grantId: mcpOauthGrants.id, companyId: mcpOauthGrants.companyId, clientId: mcpOauthGrants.clientId,
    resource: mcpOauthGrants.resource, purpose: mcpOauthGrants.purpose, scopes: mcpOauthGrants.scopes,
    tokenHash: mcpOauthTokens.tokenHash, tokenKind: mcpOauthTokens.kind,
    tokenExpiresAt: mcpOauthTokens.expiresAt, tokenUsedAt: mcpOauthTokens.usedAt,
    dotBindingId: dotAgentBindings.id, dotProvider: dotAgentBindings.providerKind,
    dotStatus: dotAgentBindings.status, dotGeneration: dotAgentBindings.generation,
    dotPairingHash: dotAgentBindings.pairingCodeHash, dotChallengeHash: dotAgentBindings.challengeHash,
    agentStatus: agents.status, membershipRole: companyMemberships.membershipRole,
  }).from(mcpOauthTokens)
    .innerJoin(mcpOauthGrants, and(eq(mcpOauthGrants.id, mcpOauthTokens.grantId), isNull(mcpOauthGrants.revokedAt)))
    .innerJoin(companies, and(eq(companies.id, mcpOauthGrants.companyId), sql`${companies.status} <> 'archived'`))
    .innerJoin(authUsers, eq(authUsers.id, mcpOauthGrants.userId))
    .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, mcpOauthGrants.companyId),
      eq(companyMemberships.principalId, mcpOauthGrants.userId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")))
    .leftJoin(agents, and(eq(agents.id, mcpOauthGrants.agentId), eq(agents.companyId, mcpOauthGrants.companyId)))
    .leftJoin(dotAgentBindings, and(eq(dotAgentBindings.grantId, mcpOauthGrants.id),
      eq(dotAgentBindings.companyId, mcpOauthGrants.companyId), eq(dotAgentBindings.agentId, mcpOauthGrants.agentId),
      eq(dotAgentBindings.operatorId, mcpOauthGrants.userId), isNull(dotAgentBindings.revokedAt)))
    .where(and(or(gt(mcpOauthTokens.expiresAt, new Date(input.now)), isNull(mcpOauthTokens.expiresAt)),


      sql`(${mcpOauthTokens.kind} <> 'refresh' OR ${mcpOauthTokens.usedAt} IS NULL)`))
    .orderBy(asc(mcpOauthTokens.id)).limit(1001);
  input.budget?.check();
  const projected = projectIdleMcpWakeProof(rows, input);
  await input.budget?.beforeRead();
  const authorities = await tx.select({ grant: mcpOauthGrants,
    dotBindingId: dotAgentBindings.id, dotProvider: dotAgentBindings.providerKind, dotStatus: dotAgentBindings.status,
    dotGeneration: dotAgentBindings.generation, dotPairingHash: dotAgentBindings.pairingCodeHash,
    dotChallengeHash: dotAgentBindings.challengeHash, agentStatus: agents.status,
    membershipRole: companyMemberships.membershipRole,
  }).from(mcpOauthGrants)
    .innerJoin(companies, and(eq(companies.id, mcpOauthGrants.companyId), sql`${companies.status} <> 'archived'`))
    .innerJoin(authUsers, eq(authUsers.id, mcpOauthGrants.userId))
    .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, mcpOauthGrants.companyId),
      eq(companyMemberships.principalId, mcpOauthGrants.userId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")))
    .leftJoin(agents, and(eq(agents.id, mcpOauthGrants.agentId), eq(agents.companyId, mcpOauthGrants.companyId)))
    .leftJoin(dotAgentBindings, and(eq(dotAgentBindings.grantId, mcpOauthGrants.id), eq(dotAgentBindings.companyId, mcpOauthGrants.companyId),
      eq(dotAgentBindings.agentId, mcpOauthGrants.agentId), eq(dotAgentBindings.operatorId, mcpOauthGrants.userId), isNull(dotAgentBindings.revokedAt)))
    .where(isNull(mcpOauthGrants.revokedAt)).orderBy(asc(mcpOauthGrants.id)).limit(1001);
  if (authorities.length > 1000) throw new Error("Too many active MCP grant authorities");
  const grantIds: string[] = [], dotBindingIds: string[] = [], revocationAuthorities: McpRevocationIndexReceipt[] = [];
  for (const row of authorities) {
    input.budget?.check();
    const grant = row.grant;
    const personal = input.personalEnabled && grant.purpose === "personal" && grant.resource === input.personalResource
      && grant.scopes.includes("paperclip:read") && grant.scopes.every(scope => (PUBLIC_MCP_SCOPES as readonly string[]).includes(scope));
    const dot = input.dotEnabled && grant.purpose === "agent" && grant.resource === input.dotResource
      && grant.scopes.includes("paperclip:agent") && grant.scopes.every(scope => (DOT_RUNNER_MCP_SCOPES as readonly string[]).includes(scope))
      && row.membershipRole !== "viewer" && row.dotProvider === "openai_dot" && ["connected", "ready"].includes(row.dotStatus ?? "")
      && row.dotBindingId !== null && row.dotGeneration !== null && Number.isSafeInteger(row.dotGeneration) && row.dotGeneration > 0
      && row.dotPairingHash === null && row.dotChallengeHash === null && row.agentStatus !== null && !["terminated", "pending_approval"].includes(row.agentStatus);
    if ((!personal && !dot) || !grant.revocationIndexReceipt) continue;
    const receipt = parseMcpRevocationIndexReceipt(grant.revocationIndexReceipt);
    if (receipt.revision !== grant.revocationRevision || receipt.authorityId !== mcpRevocationAuthorityId(grant.id, receipt.keyId)) continue;
    grantIds.push(grant.id); if (dot) dotBindingIds.push(row.dotBindingId!); revocationAuthorities.push(receipt);
  }
  if (new Set(revocationAuthorities.map(receipt => receipt.keyId)).size > 1) throw new Error("MCP revocation key rotation is incomplete");
  const allowed = new Set(grantIds);
  const tokensForAdmission = rows.filter(row => allowed.has(row.grantId));
  const rebuilt = createMcpWakeAdmission({ stackId: input.stackId, ownerId: input.ownerId, capabilityGeneration: input.capabilityGeneration,
    challenge: input.challenge, revocationAuthorities, discovery: input.discovery, clientMirror: input.clientMirror,...(!input.personalEnabled&&!input.dotEnabled?{absent:true as const}:{}),
    tokens: tokensForAdmission.filter(row => !(row.tokenKind === "refresh" && row.tokenUsedAt !== null)).map(row => ({
      profile: row.resource === input.personalResource ? "personal-mcp" as const : "dot-mcp" as const,
      tokenKind: row.tokenKind as "access" | "refresh", tokenHash: row.tokenHash, expiresAt: row.tokenExpiresAt?.toISOString() ?? null, clientId: row.clientId,
    })) });
  input.budget?.check();
  return { admission: rebuilt, grantIds: grantIds.sort(), dotBindingIds: dotBindingIds.sort(),
    generation: createHash("sha256").update(JSON.stringify([projected.generation, authorities.map(({ grant, ...authority }) => [grant.id,grant.revocationRevision,grant.revocationIndexReceipt,authority]),revocationAuthorities])).digest("hex") };

}
