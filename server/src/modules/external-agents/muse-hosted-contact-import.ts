import { notifyMuseContactVerification } from "./muse-verification-work.js";
import { and,asc,eq,inArray,sql } from "drizzle-orm";
import { museAgentBindings as bindings,museReceiverContactBuckets as buckets,agents,companies,type Db } from "@paperclipai/db";
import { museContactPageSchema,museContactPageDigest,sameMuseNamespace,type MuseHostedNamespace } from "./muse-hosted-contract.js";
/** Validate and commit immutable chunks before the existing connector sends their exact ACK. */
export async function importMuseContactPage(db:Db,namespace:MuseHostedNamespace,value:unknown) {
 const page=museContactPageSchema.parse(value);
 const {digest,...unsigned}=page;
 if(!sameMuseNamespace(page.recipientNamespace,namespace)||page.namespace.stackId!==namespace.stackId||page.namespace.origin!==namespace.origin||museContactPageDigest(unsigned)!==digest||page.through!== (page.entries.at(-1)?.sequence??page.after)
  ||page.entries.some((entry,index)=>entry.sequence!==page.after+index+1))throw new Error("Muse contact page changed");
 await db.transaction(async tx=>{
  const bindingIds=[...new Set(page.entries.map(({bucket})=>bucket.bindingId))].sort();
  if(!bindingIds.length)return;
  const candidates=await tx.select({id:bindings.id,companyId:bindings.companyId,agentId:bindings.agentId})
   .from(bindings).where(inArray(bindings.id,bindingIds)).orderBy(asc(bindings.id));
  const candidatesById=new Map(candidates.map(candidate=>[candidate.id,candidate]));
  for(const {bucket} of page.entries){
   const candidate=candidatesById.get(bucket.bindingId);
   if(candidate&&candidate.companyId!==bucket.companyId)throw new Error("Muse contact binding company changed");
  }
  // Match accounting/company deletion before touching publication or children.
  // A company lifecycle batch may retain mirror while advancing to later agents.
  const companyIds=[...new Set(candidates.map(candidate=>candidate.companyId))].sort();
  if(companyIds.length)await tx.select({id:companies.id}).from(companies)
   .where(inArray(companies.id,companyIds)).orderBy(asc(companies.id)).for("no key update");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
  // Hold every page child before the first shared mirror mutation.
  const agentOwners=new Map(candidates.map(candidate=>[`${candidate.companyId}:${candidate.agentId}`,candidate]));
  const presentAgents=new Set<string>();
  for(const candidate of [...agentOwners.values()].sort((a,b)=>a.agentId.localeCompare(b.agentId)||a.companyId.localeCompare(b.companyId))){
   const [agent]=await tx.select({id:agents.id}).from(agents)
    .where(and(eq(agents.id,candidate.agentId),eq(agents.companyId,candidate.companyId))).for("update");
   if(agent)presentAgents.add(`${candidate.companyId}:${candidate.agentId}`);
  }
  const lockedBindings=new Map<string,typeof bindings.$inferSelect>();
  for(const bindingId of bindingIds){
   const candidate=candidatesById.get(bindingId);
   // Binding IDs are not reused. Canonical absence retires custody, never evidence.
   if(!candidate)continue;
   const [binding]=await tx.select().from(bindings).where(eq(bindings.id,bindingId)).for("update");
   if(!binding)continue;
   if(binding.companyId!==candidate.companyId||binding.agentId!==candidate.agentId)throw new Error("Muse contact binding owner changed");
   if(!presentAgents.has(`${binding.companyId}:${binding.agentId}`))throw new Error("Muse contact agent is unavailable");
   lockedBindings.set(bindingId,binding);
  }
  // Preserve immutable page sequence and ACK semantics; no later binding lock
  // may be acquired after an earlier entry has taken the shared mirror row.
  for(const {bucket} of page.entries) {
   const binding=lockedBindings.get(bucket.bindingId);
   if(!binding)continue;
   if(binding.companyId!==bucket.companyId)throw new Error("Muse contact binding company changed");
   if(bucket.generation>binding.generation)throw new Error("Muse contact binding generation is unavailable");
   const row={companyId:bucket.companyId,bindingId:bucket.bindingId,bindingGeneration:bucket.generation,replicaId:bucket.id,bucketAt:new Date(bucket.bucketAt),firstAt:new Date(bucket.firstAt),lastAt:new Date(bucket.lastAt),contacts:bucket.contacts,gapsAtMostSevenSeconds:bucket.gapsAtMostSevenSeconds,maxGapMs:bucket.maxGapMs,timestamps:bucket.timestamps.map(at=>new Date(at).toISOString()),incomplete:bucket.incomplete};
   const old=await tx.select().from(buckets).where(and(eq(buckets.bindingId,row.bindingId),eq(buckets.bindingGeneration,row.bindingGeneration),eq(buckets.replicaId,row.replicaId),eq(buckets.bucketAt,row.bucketAt))).for("update");
   if(old.length){
    const prior=old[0]!;
    if(prior.contacts!==row.contacts||prior.firstAt.getTime()!==row.firstAt.getTime()||prior.lastAt.getTime()!==row.lastAt.getTime()||prior.gapsAtMostSevenSeconds!==row.gapsAtMostSevenSeconds||prior.maxGapMs!==row.maxGapMs||JSON.stringify(prior.timestamps)!==JSON.stringify(row.timestamps)||prior.incomplete!==row.incomplete)throw new Error("Muse contact chunk is not immutable");
   } else {
    if(binding.generation===row.bindingGeneration&&!binding.revokedAt)await notifyMuseContactVerification(tx,{companyId:row.companyId,bindingId:row.bindingId,generation:row.bindingGeneration},"contact-persist");
    await tx.insert(buckets).values(row);
   }
   await tx.update(bindings).set({receiverContactAt:sql`greatest(${bindings.receiverContactAt},${row.lastAt.toISOString()}::timestamptz)`}).where(and(eq(bindings.id,row.bindingId),eq(bindings.generation,row.bindingGeneration)));
  }
 });
 return {sourceId:page.sourceId,after:page.after,through:page.through,digest};
}
