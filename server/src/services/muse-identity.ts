import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { agents, companies, companyMemberships, authUsers, museAgentBindings as bindings, museCredentials as credentials, type Db } from "@paperclipai/db";
import { MUSE_ACCESS_TTL_MS, MUSE_REFRESH_INACTIVITY_MS, type AgentConnectionSubject, type MuseCredentials } from "@paperclipai/shared";
import { instanceSettingsService } from "./instance-settings.js";
import { unauthorized, forbidden } from "../errors.js";
import { withExternalAdmissionGuard, type ExternalAdmissionTransaction } from "../modules/external-agents/index.js";
import { canConfigureAgentConnection } from "../modules/agent-lifecycle/index.js";
export const museCredentialHash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
export type MuseCredentialKind = typeof credentials.$inferSelect.kind;
export type MuseIdentityDatabase = Db | ExternalAdmissionTransaction;
export async function assertMuseCurrentAuthority(db: MuseIdentityDatabase, b: typeof bindings.$inferSelect, allowSetup = false, allowPaused = false) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id,b.agentId),eq(agents.companyId,b.companyId)));
  const [company] = await db.select().from(companies).where(eq(companies.id,b.companyId));
  const [user] = await db.select({id:authUsers.id}).from(authUsers).where(eq(authUsers.id,b.operatorId));
  const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,b.companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,b.operatorId),eq(companyMemberships.status,"active")));
  const [agentMember] = await db.select({id:companyMemberships.id}).from(companyMemberships).where(and(eq(companyMemberships.companyId,b.companyId),eq(companyMemberships.principalType,"agent"),eq(companyMemberships.principalId,b.agentId),eq(companyMemberships.status,"active")));
  if (b.qualificationExpiresAt && b.qualificationExpiresAt<=new Date())throw forbidden("Muse qualification deadline elapsed; native effects are fenced.");
  if (!user || !agentMember || !member || member.membershipRole==="viewer" || !agent || company?.status!=="active"
    || agent.adapterType!=="paperclip_runner" || agent.adapterConfig.provider!=="muse" || agent.adapterConfig.museBindingId!==b.id
    || ["terminated","pending_approval"].includes(agent.status)
    || (!allowPaused && (allowSetup ? !canConfigureAgentConnection(agent) : agent.status==="paused"))
    || (!allowSetup && b.status!=="ready")) throw forbidden("Muse connection authority is unavailable.");
  return agent;
}

export function museIdentity(db: Db) {
  async function enabled() { const s=await instanceSettingsService(db).getExperimental(); return s.enableMuse && s.enableNativeRunner; }
  async function issue(tx: ExternalAdmissionTransaction, b: typeof bindings.$inferSelect, familyId: string=randomUUID()): Promise<MuseCredentials> {
    const accessToken=token(), refreshToken=token(), signalToken=token(), cleanupToken=token(), detectorCleanupToken=token();
    const accessExpiresAt=new Date(Date.now()+MUSE_ACCESS_TTL_MS), refreshExpiresAt=new Date(Date.now()+MUSE_REFRESH_INACTIVITY_MS);
    await tx.insert(credentials).values(([['access',accessToken,accessExpiresAt],['refresh',refreshToken,refreshExpiresAt],['signal',signalToken,refreshExpiresAt],['cleanup',cleanupToken,refreshExpiresAt],['detector_cleanup',detectorCleanupToken,refreshExpiresAt]] as const).map(([kind,value,expiresAt])=>({companyId:b.companyId,bindingId:b.id,bindingGeneration:b.generation,kind,familyId,tokenHash:museCredentialHash(value),expiresAt})));
    return {version:1,bindingId:b.id,generation:b.generation,companyId:b.companyId,agentId:b.agentId,accessToken,accessExpiresAt:accessExpiresAt.toISOString(),refreshToken,refreshExpiresAt:refreshExpiresAt.toISOString(),signalToken,cleanupToken,detectorCleanupToken};
  }
  async function expireQualification(b: typeof bindings.$inferSelect) {
    if (b.qualificationExpiresAt && b.qualificationExpiresAt<=new Date()) {
      const { museRunnerBroker }=await import("./muse-runner-broker.js");
      await museRunnerBroker(db).endQualification({companyId:b.companyId,agentId:b.agentId,bindingId:b.id,qualificationId:b.qualificationId!,operatorId:b.operatorId});
      throw unauthorized("Muse qualification deadline elapsed; normal authority was fenced.");
    }
  }
  return {
    enabled,
    async pair(ticket: string, clientVersion: string): Promise<MuseCredentials> {
      if (!await enabled()) throw forbidden("Muse is disabled for new connections.");
      const [candidate]=await db.select().from(bindings).where(eq(bindings.ticketHash,museCredentialHash(ticket)));
      if (!candidate) throw unauthorized("Pairing ticket expired or was consumed.");
      return db.transaction(tx=>withExternalAdmissionGuard(tx,candidate.companyId,candidate.agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,candidate.id),eq(bindings.ticketHash,museCredentialHash(ticket)),eq(bindings.status,"pairing"),isNull(bindings.revokedAt),gt(bindings.ticketExpiresAt,new Date()))).for("update");
        if (!b) throw unauthorized("Pairing ticket expired or was consumed.");
        await assertMuseCurrentAuthority(tx,b,true);
        const [paired]=await tx.update(bindings).set({status:"connected",ticketHash:null,ticketExpiresAt:null,pairedAt:new Date(),workerActivityAt:new Date(),clientVersion,revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id)).returning();
        return issue(tx,paired!);
      }));
    },
    async refresh(value: string): Promise<MuseCredentials> {
      if (!await enabled()) throw forbidden("Muse normal credentials are disabled.");
      const [candidate]=await db.select().from(credentials).where(and(eq(credentials.tokenHash,museCredentialHash(value)),eq(credentials.kind,"refresh")));
      if (!candidate) throw unauthorized("Refresh credential is unavailable; reconnect Muse.");
      const [b]=await db.select().from(bindings).where(eq(bindings.id,candidate.bindingId));
      if (!b) throw unauthorized();
      await expireQualification(b);
      // Replay revocation must commit even though the request is then rejected.
      const result=await db.transaction(tx=>withExternalAdmissionGuard(tx,b.companyId,b.agentId,async()=>{
        const [binding]=await tx.select().from(bindings).where(eq(bindings.id,b.id)).for("update");
        const [old]=await tx.select().from(credentials).where(eq(credentials.id,candidate.id)).for("update");
        if (old?.consumedAt) {
          await tx.update(credentials).set({revokedAt:new Date()}).where(and(eq(credentials.familyId,old.familyId),inArray(credentials.kind,["access","refresh","signal"])));
          return null;
        }
        if (!binding || binding.revokedAt || binding.generation!==old?.bindingGeneration || old.revokedAt || old.expiresAt<=new Date()) return null;
        await assertMuseCurrentAuthority(tx,binding,true,true);
        await tx.update(credentials).set({consumedAt:new Date()}).where(eq(credentials.id,old.id));
        await tx.update(credentials).set({revokedAt:new Date()}).where(and(eq(credentials.familyId,old.familyId),eq(credentials.bindingId,binding.id),inArray(credentials.kind,["access","signal"])));
        await tx.update(bindings).set({workerActivityAt:new Date(),updatedAt:new Date()}).where(eq(bindings.id,binding.id));
        return issue(tx,binding,old.familyId);
      }));
      if (!result) throw unauthorized("Refresh replay, expiry, or lost rotation requires reconnect.");
      return result;
    },
    async authenticate(value: string, kind: MuseCredentialKind="access"): Promise<AgentConnectionSubject> {
      const [c]=await db.select().from(credentials).where(and(eq(credentials.tokenHash,museCredentialHash(value)),eq(credentials.kind,kind),isNull(credentials.revokedAt),isNull(credentials.consumedAt),gt(credentials.expiresAt,new Date())));
      const [b]=c?await db.select().from(bindings).where(and(eq(bindings.id,c.bindingId),eq(bindings.companyId,c.companyId))):[];
      if (!c || !b) throw unauthorized("Muse credential is unavailable.");
      const cleanup=kind==="cleanup" || kind==="detector_cleanup";
      if (cleanup) {
        if (!b.revokedAt || !b.cleanupExpiresAt || b.cleanupExpiresAt<=new Date() || c.bindingGeneration!==b.generation) throw unauthorized("Cleanup authority expired.");
      } else {
        await expireQualification(b);
        if (!await enabled() || b.revokedAt || c.bindingGeneration!==b.generation) throw unauthorized("Muse authority was fenced.");
        await assertMuseCurrentAuthority(db,b,true,true);
        if (kind==="access") {
          await db.update(bindings).set({workerActivityAt:new Date()}).where(and(eq(bindings.id,b.id),eq(bindings.generation,b.generation),isNull(bindings.revokedAt)));
          await db.update(credentials).set({expiresAt:new Date(Date.now()+MUSE_REFRESH_INACTIVITY_MS)}).where(and(eq(credentials.bindingId,b.id),eq(credentials.bindingGeneration,b.generation),eq(credentials.familyId,c.familyId),eq(credentials.kind,"refresh"),isNull(credentials.consumedAt),isNull(credentials.revokedAt)));
        }
      }
      return {provider:"muse",companyId:b.companyId,agentId:b.agentId,bindingId:b.id,generation:c.bindingGeneration,authorizingUserId:b.operatorId,credentialId:c.id};
    },
  };
}
