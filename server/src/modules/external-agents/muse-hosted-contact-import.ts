import { notifyMuseContactVerification } from "./muse-verification-work.js";
import { and,eq,sql } from "drizzle-orm";
import { museAgentBindings as bindings,museReceiverContactBuckets as buckets,agents,type Db } from "@paperclipai/db";
import { museContactPageSchema,museContactPageDigest,sameMuseNamespace,type MuseHostedNamespace } from "./muse-hosted-contract.js";
/** Validate and commit immutable chunks before the existing connector sends their exact ACK. */
export async function importMuseContactPage(db:Db,namespace:MuseHostedNamespace,value:unknown) {
 const page=museContactPageSchema.parse(value);
 const {digest,...unsigned}=page;
 if(!sameMuseNamespace(page.recipientNamespace,namespace)||page.namespace.stackId!==namespace.stackId||page.namespace.origin!==namespace.origin||museContactPageDigest(unsigned)!==digest||page.through!== (page.entries.at(-1)?.sequence??page.after)
  ||page.entries.some((entry,index)=>entry.sequence!==page.after+index+1))throw new Error("Muse contact page changed");
 await db.transaction(async tx=>{
  for(const {bucket} of page.entries) {
   const [candidate]=await tx.select().from(bindings).where(and(eq(bindings.id,bucket.bindingId),eq(bindings.companyId,bucket.companyId)));
   if(!candidate)throw new Error("Muse contact binding is unavailable");
   const [agent]=await tx.select({id:agents.id}).from(agents).where(and(eq(agents.id,candidate.agentId),eq(agents.companyId,bucket.companyId))).for("update");
   if(!agent)throw new Error("Muse contact agent is unavailable");
   const [binding]=await tx.select().from(bindings).where(and(eq(bindings.id,bucket.bindingId),eq(bindings.companyId,bucket.companyId),eq(bindings.agentId,agent.id))).for("update");
   if(!binding||bucket.generation>binding.generation)throw new Error("Muse contact binding generation is unavailable");
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
