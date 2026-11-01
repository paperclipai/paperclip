import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { museAgentBindings as bindings, museMailboxItems as mailbox, museRunnerAssignments as assignments, museReceiverContactBuckets as buckets, externalAgentHolds as holds, type Db } from "@paperclipai/db";
import { assertMuseReceiverAuthority, assertMuseCurrentAuthority, inspectMuseConnectionCredential, museIdentity, museStopControlBoundaryIds, hasMuseStopControlAccess } from "./muse-identity.js";
import { canConfigureAgentConnection } from "../modules/agent-lifecycle/index.js";
import { HttpError } from "../errors.js";
const PERSISTENCE_LAG_MS=30_000;
const instances=new WeakMap<Db,ReturnType<typeof createReceiver>>();
export function museReceiver(db:Db) {let receiver=instances.get(db);if(!receiver){receiver=createReceiver(db);instances.set(db,receiver);}return receiver;}
function createReceiver(db:Db) {
  const replicaId=randomUUID();
  const pending=new Map<string,{companyId:string;bindingId:string;bindingGeneration:number;bucketAt:Date;firstAt:Date;lastAt:Date;contacts:number;gapsAtMostSevenSeconds:number;maxGapMs:number;timestamps:string[];incomplete:boolean}>();
  const previous=new Map<string,number>();
  let flushPromise:Promise<void>|undefined;
  async function flush() {
    if(flushPromise)return flushPromise;
    flushPromise=(async()=>{
      const batch=[...pending.entries()];pending.clear();
      for(const [key,bucket]of batch) {
        try {
          await db.transaction(async tx=>{
            await tx.insert(buckets).values({...bucket,replicaId}).onConflictDoUpdate({target:[buckets.bindingId,buckets.bindingGeneration,buckets.replicaId,buckets.bucketAt],set:{lastAt:bucket.lastAt,contacts:sql`${buckets.contacts}+${bucket.contacts}`,gapsAtMostSevenSeconds:sql`${buckets.gapsAtMostSevenSeconds}+${bucket.gapsAtMostSevenSeconds}`,maxGapMs:sql`greatest(${buckets.maxGapMs},${bucket.maxGapMs})`,timestamps:sql`${buckets.timestamps} || ${JSON.stringify(bucket.timestamps)}::jsonb`,incomplete:sql`${buckets.incomplete} or ${bucket.incomplete}`}});
            await tx.update(bindings).set({receiverContactAt:sql`greatest(${bindings.receiverContactAt},${bucket.lastAt.toISOString()}::timestamptz)`}).where(and(eq(bindings.id,bucket.bindingId),eq(bindings.generation,bucket.bindingGeneration)));
          });
          const [current]=await db.select().from(bindings).where(and(eq(bindings.id,bucket.bindingId),eq(bindings.generation,bucket.bindingGeneration),isNull(bindings.revokedAt)));
          if(current?.pairedAt&&!current.verifiedReplyAt&&!current.challengeHash) {
            const {museRunnerBroker}=await import("./muse-runner-broker.js");
            await museRunnerBroker(db).verify(current.companyId,current.agentId,{bindingId:current.id,generation:current.generation,expectedRevision:current.revision}).catch(()=>{});
          }
        } catch {
          const newer=pending.get(key);
          if(newer){newer.firstAt=bucket.firstAt;newer.contacts+=bucket.contacts;newer.timestamps=[...bucket.timestamps,...newer.timestamps].slice(0,60);newer.incomplete=true;}
          else pending.set(key,{...bucket,incomplete:true});
        }
      }
    })().finally(()=>{flushPromise=undefined;});return flushPromise;
  }
  function recordPublicContact(b: typeof bindings.$inferSelect, now: number) {
    const key = `${b.id}:${b.generation}:${Math.floor(now / PERSISTENCE_LAG_MS)}`;
    const gap = previous.has(b.id) ? now - previous.get(b.id)! : 0;
    previous.set(b.id, now);
    let bucket = pending.get(key);
    if (!bucket) {
      bucket = { companyId: b.companyId, bindingId: b.id, bindingGeneration: b.generation,
        bucketAt: new Date(Math.floor(now / PERSISTENCE_LAG_MS) * PERSISTENCE_LAG_MS),
        firstAt: new Date(now), lastAt: new Date(now), contacts: 0,
        gapsAtMostSevenSeconds: 0, maxGapMs: 0, timestamps: [], incomplete: false };
      pending.set(key, bucket);
    }
    bucket.contacts++; bucket.lastAt = new Date(now);
    if (gap > 0 && gap <= 7000) bucket.gapsAtMostSevenSeconds++;
    bucket.maxGapMs = Math.max(bucket.maxGapMs, gap);
    if (bucket.timestamps.length < 60) bucket.timestamps.push(new Date(now).toISOString());
    else bucket.incomplete = true;
  }
  /** A public binding reference is presence evidence, never worker authority. */
  async function signal(bindingId: string, expectedResource?:string) {
    const idle = { version: 1 as const, signal: null };
    const unavailable = () => new HttpError(410, "Muse receiver is unavailable.");
    const [candidate] = await db.select().from(bindings).where(eq(bindings.id, bindingId));
    if (!candidate || candidate.revokedAt || !candidate.pairedAt) throw unavailable();
    if (candidate.qualificationExpiresAt && candidate.qualificationExpiresAt <= new Date()) {
      const { museRunnerBroker } = await import("./muse-runner-broker.js");
      await museRunnerBroker(db).endQualification({ companyId: candidate.companyId, agentId: candidate.agentId,
        bindingId: candidate.id, qualificationId: candidate.qualificationId!, operatorId: candidate.operatorId });
      throw unavailable();
    }
    let contacted: typeof bindings.$inferSelect | undefined;
    const result = await db.transaction(async tx => {
      const [current] = await tx.select().from(bindings).where(and(eq(bindings.id, candidate.id),
        eq(bindings.generation, candidate.generation), isNull(bindings.revokedAt))).for("update");
      if (!current) throw unavailable();
      let agent;
      try {
        const credential=await inspectMuseConnectionCredential(tx,current,expectedResource);
        if(credential.state==="pending"){
          await assertMuseCurrentAuthority(tx,current,true,true);contacted=current;return idle;
        }
        agent = await assertMuseReceiverAuthority(tx, current,expectedResource);
      }
      catch (error) {
        // Infrastructure failures must not permanently uninstall a healthy hook.
        if (error instanceof HttpError && [401, 403, 404, 410].includes(error.status)) throw unavailable();
        throw error;
      }
      contacted = current;
      // Pausing suppresses ordinary work, while the worker still needs its
      // exact stop boundary to quiesce and report through authenticated control.
      const disabled=!await museIdentity(db).enabled();
      if(disabled&&!await hasMuseStopControlAccess(tx,current))return idle;
      const stopOnly = disabled || (agent.status === "paused" && !canConfigureAgentConnection(agent));
      const boundaries=tx.select({boundary:holds.stopBoundary}).from(holds).where(inArray(holds.id,museStopControlBoundaryIds(tx,current)));
      const [item] = await tx.select({ item: mailbox }).from(mailbox).leftJoin(assignments, eq(assignments.id, mailbox.assignmentId))
        .where(and(eq(mailbox.bindingId, current.id), eq(mailbox.bindingGeneration, current.generation),
          stopOnly ? and(eq(mailbox.kind,"authority_revoked"),sql`${mailbox.id} > ${current.workerCursor}`,inArray(sql`${mailbox.references}->'boundary'`,boundaries))
            : sql`((${mailbox.kind} = 'assignment' and ${assignments.claimedAt} is null and ${assignments.status} = 'offered') or (${mailbox.kind} = 'readiness_challenge' and ${!!current.challengeHash && !!current.challengeExpiresAt && current.challengeExpiresAt > new Date()} and ${mailbox.id} > ${current.workerCursor} and encode(sha256(convert_to(${mailbox.references}->>'nonce','UTF8')),'hex') = ${current.challengeHash}) or (${mailbox.kind} not in ('assignment','readiness_challenge') and ${mailbox.id} > ${current.workerCursor}))`))
        .orderBy(asc(mailbox.id)).limit(1);
      if (!item) return idle;
      const now = Date.now(), rearm = !item.item.signalNotifiedAt || item.item.signalNotifiedAt.getTime() <= now - 30_000;
      const attempt = item.item.signalAttempt + (rearm ? 1 : 0);
      if (rearm) await tx.update(mailbox).set({ signalAttempt: attempt, signalNotifiedAt: new Date(now) }).where(eq(mailbox.id, item.item.id));
      // UUID-bearing event identity prevents enumeration of global mailbox IDs.
      const reference = "sha256:" + createHash("sha256").update(`${current.id}:${current.generation}:${item.item.sourceEventId}:${attempt}`).digest("hex");
      return { version: 1 as const, signal: { reference } };
    });
    if (contacted) recordPublicContact(contacted, Date.now());
    return result;
  }
  let timer:NodeJS.Timeout|undefined;
  function start() {if(timer)return;timer=setInterval(()=>void flush().catch(()=>{}),PERSISTENCE_LAG_MS);timer.unref();}
  async function stop() {if(timer)clearInterval(timer);timer=undefined;await flush();}
  return {signal,flush,start,stop,persistenceLagMs:PERSISTENCE_LAG_MS};
}
