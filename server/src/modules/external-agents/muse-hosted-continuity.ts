import { and,eq,gt,isNotNull,isNull } from "drizzle-orm";
import { museAgentBindings as bindings,type Db } from "@paperclipai/db";
import { getCloudRuntimeIdentity } from "../../services/cloud-runtime-identity.js";
import { createPaperclipCloudConnector,paperclipCloudConnectorConfigFromEnv } from "../../services/paperclip-cloud-connector.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { syncMuseContactCustody } from "./muse-hosted-sync.js";
import { readMuseReceiverProjection } from "./muse-hosted-projection.js";
import { sameMuseNamespace } from "./muse-hosted-contract.js";
/** One bounded startup reconciliation; no timer or cached allow decision. */
export async function recoverMuseReceiverContinuity(db:Db,signal:AbortSignal):Promise<ReadonlyMap<string,number>> {
 const none=new Map<string,number>(),identity=getCloudRuntimeIdentity(),config=paperclipCloudConnectorConfigFromEnv();
 if(!identity||!config||!identity.canonicalOrigin)return none;
 const flags=await instanceSettingsService(db).getExperimentalReadOnly();
 if(!flags.enableMuse||!flags.enableNativeRunner)return none;
 const [qualification]=await db.select({id:bindings.id}).from(bindings).where(and(isNull(bindings.revokedAt),isNotNull(bindings.pairedAt),gt(bindings.qualificationExpiresAt,new Date()))).limit(1);
 if(!qualification)return none;
 const namespace={stackId:identity.stackId,instanceId:config.instanceId,origin:identity.canonicalOrigin};
 const connector=createPaperclipCloudConnector({config});
 const ownership=await syncMuseContactCustody(db,namespace,body=>connector.syncMuseReceiverContacts(body),signal);
 if(ownership.state==="pending")throw new Error("Muse receiver continuity awaits its current publication");
 if(ownership.state!=="owned")return none;
 if(!sameMuseNamespace(ownership.namespace,namespace))throw new Error("Muse receiver continuity namespace changed");
 // Recompute from CURRENT authorization and generation. A remembered ACK or
 // enabled flag alone cannot suppress the normal lost-memory marker.
 const current=await readMuseReceiverProjection(db,namespace,ownership.revision,{enabled:true,contactImportWakeVersion:ownership.reference.contactImportWakeVersion});
 if(!current.complete)return none;
 if(JSON.stringify(current.reference)!==JSON.stringify(ownership.reference))return none;
 return new Map(current.records.filter(row=>row.state!=="retired").map(row=>[row.bindingId,row.generation]));
}
