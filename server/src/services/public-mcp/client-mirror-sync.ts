import { mcpClientMirrorClientPages, mcpClientMirrorDevicePages } from "./client-mirror-pages.js";
import { getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";
import { mcpDeviceStatusEntrySchema,mcpDeviceStatusFingerprint,mcpDeviceStatusGeneration,mcpDeviceStatusKeyId } from "./device-status-contract.js";
import { deriveLocalEncryptedInstanceSecret } from "../../secrets/local-encrypted-provider.js";
import { prepareMcpClientMutation } from "./client-mirror-mutations.js";
import { installMcpDeviceCutover } from "./device-cutover.js";
import { prepareMcpClientMirrorPolicy } from "./client-mirror-mutations.js";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { mcpOauthClients as clients,mcpOauthDeviceRequests as devices, mcpOauthClientMirrorState as state, mcpOauthClientChanges as changes, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../instance-settings.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from "../paperclip-cloud-connector.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { mcpClientMirrorGeneration, mcpClientMirrorReceiptSchema, mcpClientMirrorResponseSchema, mcpMirroredClientSchema,
  type McpClientMirrorChange, type McpClientMirrorRequest, type McpClientMirrorReceipt } from "./client-mirror-contract.js";

export function sameMcpClientMirrorReceipt(left:McpClientMirrorReceipt,right:McpClientMirrorReceipt){
  return left.version===right.version&&left.instanceId===right.instanceId&&left.origin===right.origin
    &&left.revision===right.revision&&left.enabled===right.enabled&&left.generation===right.generation
    &&left.frontDoor===right.frontDoor&&(left.authorizationOrigin??left.origin)===(right.authorizationOrigin??right.origin)
    &&left.deviceStatus?.keyId===right.deviceStatus?.keyId&&left.deviceStatus?.generation===right.deviceStatus?.generation
    &&left.deviceStatus?.count===right.deviceStatus?.count;
}

export function startMcpClientMirrorSync(db: Db, coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>,"register">,
  origin: string | undefined, input: {authorizationOrigin?:string;instanceId?:string;publish?:(request:McpClientMirrorRequest)=>Promise<unknown>} = {}) {
  const config = paperclipCloudConnectorConfigFromEnv();
  const connector = config ? createPaperclipCloudConnector({config}) : undefined;
  const instanceId = input.instanceId ?? config?.instanceId;
  const publish = input.publish ?? (connector ? (request:McpClientMirrorRequest) => connector.syncMcpClientMirror(JSON.stringify(request)) : undefined);
  let pending = true,refreshPublished=true,fullRecovery=false,reserveFullRevision=false;
  let boundStackId=getCloudRuntimeIdentity()?.stackId;
  const worker=coordinator.register(DELIVERY_QUEUES.mcpClientMirror, {
    retryMs:5_000,pausePassiveMaintenance:true,onSettled:()=>{pending=true;},
    async run(signal) {
      pending=false;
      const managedIdentity=getCloudRuntimeIdentity();
      if(!managedIdentity)return;
      if (!origin || !instanceId || !publish) return;
      let enabled=false,publicationAttempted=false;
      try {
        enabled=(await instanceSettingsService(db).getExperimentalReadOnly()).enablePublicMcp;
        const assertCurrentAuthority=()=>{
          const identity=getCloudRuntimeIdentity(),currentConfig=paperclipCloudConnectorConfigFromEnv();
          if(!identity||identity.stackId!==managedIdentity.stackId||boundStackId!==undefined&&identity.stackId!==boundStackId
            ||identity.canonicalOrigin!==origin||config&&(!currentConfig||currentConfig.instanceId!==instanceId
              ||currentConfig.baseUrl!==config.baseUrl||currentConfig.environment!==config.environment
              ||currentConfig.signPrivateKey!==config.signPrivateKey||currentConfig.sealPrivateKey!==config.sealPrivateKey))throw new Error("MCP client mirror current authority changed");
          boundStackId??=identity.stackId;
        };
        if(enabled)assertCurrentAuthority();
        const publishEnabled=(request:McpClientMirrorRequest)=>{assertCurrentAuthority();publicationAttempted=true;return publish(request);};
        const captured=await db.transaction(async tx=>{
          await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
          if(enabled)await tx.insert(state).values({id:"public",revision:0}).onConflictDoNothing();
          const [row]=await tx.select().from(state).where(eq(state.id,"public")).for("update");
          if(!row)return;
          if(row.enabled===enabled){
            if(!enabled||!reserveFullRevision&&(!refreshPublished||row.receipt===null))return row;
            await prepareMcpClientMutation(tx as unknown as Db);
            return(await tx.select().from(state).where(eq(state.id,"public")))[0];
          }
          await prepareMcpClientMirrorPolicy(tx as unknown as Db,enabled);
          return(await tx.select().from(state).where(eq(state.id,"public")))[0];
        });
        refreshPublished=false;
        if(enabled&&captured&&fullRecovery)reserveFullRevision=false;
        if(!captured&&!enabled)return;
        if (!captured || !Number.isSafeInteger(captured.revision) || captured.revision < 0) throw new Error("Invalid MCP client mirror state");
        const generation = mcpClientMirrorGeneration({instanceId,origin,revision:captured.revision,enabled});
        const old = mcpClientMirrorReceiptSchema.safeParse(captured.receipt);
        const baseRevision = !fullRecovery && old.success && old.data.instanceId===instanceId && old.data.origin===origin && old.data.revision<=captured.revision
          && old.data.generation===mcpClientMirrorGeneration(old.data) ? old.data.revision : null;
        if (!enabled&&baseRevision===captured.revision&&old.success&&old.data.enabled===false) return;
        if(!enabled){
          if(!captured.remoteResponsibility)return;
          const result=mcpClientMirrorResponseSchema.parse(await publish({version:1,instanceId,origin,revision:captured.revision,baseRevision:null,expectedRecords:0,operation:"disable"}));
          if(!result.complete||result.receipt.enabled||result.receipt.instanceId!==instanceId||result.receipt.origin!==origin||result.receipt.revision!==captured.revision||result.receipt.generation!==generation)throw new Error("MCP client mirror disable was not acknowledged");
          const [ack]=await db.update(state).set({receipt:result.receipt,remoteResponsibility:false}).where(and(eq(state.id,"public"),eq(state.revision,captured.revision))).returning({id:state.id});
          if(!ack)pending=true;
          return;
        }
        const deviceKey=deriveLocalEncryptedInstanceSecret(`mcp-device-status:v1:${instanceId}`),keyId=mcpDeviceStatusKeyId(deviceKey);
        const deviceRows=await db.select({requestId:devices.id,deviceCodeHash:devices.deviceCodeHash,clientId:devices.clientId,resource:devices.resource,ingressOwner:devices.ingressOwner,status:devices.status,expiresAt:devices.expiresAt}).from(devices).where(eq(devices.resource,origin+"/mcp/paperclip")).orderBy(devices.id).limit(1001);
        if(deviceRows.length>1000)throw new Error("MCP retained device set exceeds canonical1000 admission bound");
        const entries=deviceRows.map(row=>mcpDeviceStatusEntrySchema.parse({requestId:row.requestId,clientId:row.clientId,resource:row.resource,ingressOwner:row.ingressOwner,status:row.status,expiresAt:row.expiresAt.getTime(),fingerprint:mcpDeviceStatusFingerprint(deviceKey,row.deviceCodeHash,row.clientId,row.resource)}));
        const deviceStatus={keyId,generation:mcpDeviceStatusGeneration({instanceId,origin,revision:captured.revision,keyId},entries),count:entries.length};
        if(baseRevision===captured.revision&&old.success){
          if(JSON.stringify(old.data.deviceStatus)===JSON.stringify(deviceStatus)&&(old.data.authorizationOrigin??origin)===(input.authorizationOrigin??origin))return;
          await db.transaction(async tx=>{
            await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
            const [current]=await tx.select({revision:state.revision}).from(state).where(eq(state.id,"public")).for("update");
            if(current?.revision===captured.revision)await prepareMcpClientMutation(tx as unknown as Db);
          });
          pending=true;return;
        }
        const [count] = baseRevision===null ? await db.select({total:sql<number>`count(*)::int`}).from(clients)
          : await db.select({total:sql<number>`count(*)::int`}).from(changes).where(and(gt(changes.revision,baseRevision),lte(changes.revision,captured.revision)));
        if (!count || !Number.isSafeInteger(count.total) || count.total<0) throw new Error("Invalid MCP client mirror count");
        const identity = {version:1 as const,instanceId,origin,revision:captured.revision,baseRevision,expectedRecords:count.total,deviceStatus,...(input.authorizationOrigin?{authorizationOrigin:input.authorizationOrigin}:{})};
        const [owned]=await db.update(state).set({remoteResponsibility:true}).where(and(eq(state.id,"public"),eq(state.revision,captured.revision))).returning({id:state.id});
        if(!owned){pending=true;return;}
        let result = mcpClientMirrorResponseSchema.parse(await publishEnabled({...identity,operation:"begin",deviceKey}));
        if (!result.complete) {
          const resumeSequence=result.nextSequence,resumeDeviceSequence=result.nextDeviceSequence??0;
          let cursor:string|undefined, sequence=0, sent=0;
          while (true) {
            signal.throwIfAborted();
            const rows: {clientId:string;change:McpClientMirrorChange}[] = baseRevision===null
              ? (await db.select({id:clients.id,name:clients.name,redirectUris:clients.redirectUris,grantTypes:clients.grantTypes}).from(clients)
                .where(cursor ? sql`${clients.id} COLLATE "C" > ${cursor}` : undefined).orderBy(sql`${clients.id} COLLATE "C"`).limit(200))
                .map(row=>({clientId:row.id,change:{operation:"upsert" as const,client:mcpMirroredClientSchema.parse(row)}}))
              : (await db.select({change:changes,client:{id:clients.id,name:clients.name,redirectUris:clients.redirectUris,grantTypes:clients.grantTypes}}).from(changes)
                .leftJoin(clients,eq(clients.id,changes.clientId)).where(and(gt(changes.revision,baseRevision),lte(changes.revision,captured.revision),cursor?sql`${changes.clientId} COLLATE "C" > ${cursor}`:undefined))
                .orderBy(sql`${changes.clientId} COLLATE "C"`).limit(200)).map(({change:row,client})=>{
                  if(row.operation==="delete")return{clientId:row.clientId,change:{operation:"delete" as const,clientId:row.clientId}};
                  if(!client)throw new Error("MCP client changed during publication");
                  return{clientId:row.clientId,change:{operation:"upsert" as const,client:mcpMirroredClientSchema.parse(client)}};
                });
            if(!rows.length)break;
            for(const page of mcpClientMirrorClientPages(identity,sequence,rows.map(row=>row.change))){
              if(sequence>=resumeSequence)result=mcpClientMirrorResponseSchema.parse(await publishEnabled(page));
              sequence++;sent+=page.changes.length;
            }
            cursor=rows.at(-1)!.clientId;
            if(rows.length<200)break;
          }
          for(const page of mcpClientMirrorDevicePages(identity,entries)){
            if(page.sequence>=resumeDeviceSequence)result=mcpClientMirrorResponseSchema.parse(await publishEnabled(page));
          }
          signal.throwIfAborted();
          const [current]=await db.select({revision:state.revision}).from(state).where(eq(state.id,"public"));
          if(current&&Number.isSafeInteger(current.revision)&&current.revision>captured.revision){pending=true;return;}
          if(current?.revision!==captured.revision || sent!==count.total)throw new Error("MCP client mirror changed during publication");
          result=mcpClientMirrorResponseSchema.parse(await publishEnabled({...identity,operation:"complete"}));
        }
        if(!result.complete||!result.receipt.enabled||JSON.stringify(result.receipt.deviceStatus)!==JSON.stringify(deviceStatus)||result.receipt.instanceId!==instanceId||result.receipt.origin!==origin||result.receipt.revision!==captured.revision||result.receipt.generation!==mcpClientMirrorGeneration(result.receipt))throw new Error("MCP client mirror was not acknowledged");
        const receipt=result.receipt;
        let retained=false;
        await db.transaction(async tx=>{
          await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
          const [current]=await tx.select().from(state).where(eq(state.id,"public")).for("update");
          assertCurrentAuthority();
          if(!current||!current.enabled){pending=true;return;}
          if(!Number.isSafeInteger(current.revision)||current.revision<receipt.revision)throw new Error("MCP client mirror ACK revision regressed");
          if((receipt.authorizationOrigin??origin)!==(input.authorizationOrigin??origin))throw new Error("MCP client mirror ACK issuer changed");
          const prior=mcpClientMirrorReceiptSchema.safeParse(current.receipt);
          if(current.receipt!==null&&(!prior.success||prior.data.generation!==mcpClientMirrorGeneration(prior.data)))throw new Error("MCP client mirror ACK base changed");
          if(current.revision>receipt.revision&&(!prior.success||!prior.data.enabled||prior.data.instanceId!==instanceId||prior.data.origin!==origin)){
            pending=true;return;
          }
          if(prior.success&&prior.data.revision>receipt.revision){pending=true;return;}
          if(prior.success&&prior.data.revision===receipt.revision&&!sameMcpClientMirrorReceipt(prior.data,receipt))throw new Error("MCP client mirror ACK generation changed");
          await tx.update(state).set({receipt}).where(eq(state.id,"public"));
          retained=true;
          if(current.revision!==receipt.revision){pending=true;return;}
          await installMcpDeviceCutover(tx as unknown as Db,receipt);
          await tx.delete(changes).where(lte(changes.revision,receipt.revision));
        });
        if(retained){fullRecovery=false;reserveFullRevision=false;}
      } catch(error){
        if(enabled&&publicationAttempted&&!fullRecovery){fullRecovery=true;reserveFullRevision=true;}
        pending=true;throw error;
      }
    },
    hasPending:async()=>false,nextRunAt:()=>pending?Date.now()+5_000:null,
  });
  return {worker,instanceId};
}
