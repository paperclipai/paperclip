import { logger } from "../middleware/logger.js";
import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import { museAgentBindings as bindings, type Db } from "@paperclipai/db";
import { museRunnerBroker } from "./muse-runner-broker.js";
import { museReceiver } from "./muse-receiver.js";
/** Deadline authority lives in the database; every fresh process recovers it. */
export function startMuseMaintenance(db:Db) {
  const broker=museRunnerBroker(db),receiver=museReceiver(db);
  let running=false;
  const sweep=async()=>{
    if(running)return;running=true;
    try{
      let after:string|undefined;
      while(true) {
        const expired=await db.select().from(bindings).where(and(isNull(bindings.revokedAt),lte(bindings.qualificationExpiresAt,new Date()),after?gt(bindings.id,after):undefined)).orderBy(asc(bindings.id)).limit(100);
        for(const b of expired)if(b.qualificationId)try{await broker.endQualification({companyId:b.companyId,agentId:b.agentId,bindingId:b.id,qualificationId:b.qualificationId,operatorId:b.operatorId});}catch{logger.warn({bindingId:b.id},"Muse qualification deadline maintenance failed; authority remains denied and will retry.");}
        if(expired.length<100)break;after=expired.at(-1)!.id;
      }
      after=undefined;
      while(true) {
        const active=await db.select().from(bindings).where(and(isNull(bindings.revokedAt),after?gt(bindings.id,after):undefined)).orderBy(asc(bindings.id)).limit(100);
        for(const b of active)try{await broker.reconcileTerminalAssignments(b.companyId,b.agentId,b.id);}catch{logger.warn({bindingId:b.id},"Muse terminal reconciliation failed; unresolved holds remain and will retry.");}
        if(active.length<100)break;after=active.at(-1)!.id;
      }
    }finally{running=false;}
  };
  // A process restart loses any not-yet-persisted ingress tail. It is explicit
  // incomplete qualification evidence even when subsequent traffic is healthy.
  void db.update(bindings).set({cadenceEvidenceIncompleteAt:new Date()}).where(and(isNull(bindings.revokedAt),gt(bindings.qualificationExpiresAt,new Date()))).then(()=>sweep()).catch(()=>{logger.warn("Muse startup qualification evidence marking failed.");});
  const timer=setInterval(()=>void sweep().catch(()=>{logger.warn("Muse maintenance sweep failed; persisted authority checks remain active.");}),5000);timer.unref();receiver.start();
  return async()=>{clearInterval(timer);await receiver.stop();};
}
