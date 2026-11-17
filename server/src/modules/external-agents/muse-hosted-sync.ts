import { museContactExchangeSchema,type MuseHostedNamespace } from "./muse-hosted-contract.js";
import { importMuseContactPage } from "./muse-hosted-contact-import.js";
import type { Db } from "@paperclipai/db";
export async function syncMuseContactCustody(db:Db,namespace:MuseHostedNamespace,exchange:(serialized:string)=>Promise<unknown>,signal:AbortSignal) {
 // A pass is bounded; concrete remaining chunks stay in the existing queue via its caller's pending flag.
 const lastThrough=new Map<string,number>();
 for(let pageNumber=0;pageNumber<1000;pageNumber++){
  signal.throwIfAborted();const response=museContactExchangeSchema.parse(await exchange(JSON.stringify({version:1,operation:"read"}))),page=response.page;
  if(!page.entries.length)return response.ownership;
  if(page.through<=(lastThrough.get(page.sourceId)??-1))throw new Error("Muse contact import did not advance");
  lastThrough.set(page.sourceId,page.through);
  await importMuseContactPage(db,namespace,page);
  signal.throwIfAborted();await exchange(JSON.stringify({version:1,operation:"ack",page}));
 }
 throw new Error("Muse contact custody remains pending after bounded import");
}

/** Existing read/commit/exact-ACK owner, joined before qualification evidence is
 * assessed. Hard expiry/revocation is enforced independently and never renewed.
 * This does not infer continuity from mirror revisions or produce task authority.
 */
export async function syncCurrentMuseContactEvidence(db:Db,signal:AbortSignal) {
 const {getCloudRuntimeIdentity}=await import("../../services/cloud-runtime-identity.js");
 const {createPaperclipCloudConnector,paperclipCloudConnectorConfigFromEnv}=await import("../../services/paperclip-cloud-connector.js");
 const identity=getCloudRuntimeIdentity();
 if(!identity)return;
 const config=paperclipCloudConnectorConfigFromEnv();
 if(!config||!identity.canonicalOrigin)throw new Error("Muse contact evidence awaits its current hosted owner");
 const namespace={stackId:identity.stackId,instanceId:config.instanceId,origin:identity.canonicalOrigin};
 const connector=createPaperclipCloudConnector({config});
 await syncMuseContactCustody(db,namespace,serialized=>connector.syncMuseReceiverContacts(serialized),signal);
}
