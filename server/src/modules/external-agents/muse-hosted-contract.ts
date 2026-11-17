import { createHash } from "node:crypto";
import {
  museHostedNamespaceSchema, museReceiverRecordSchema,
  type MuseHostedNamespace, type MuseReceiverRecord, type MuseContactPage,
} from "@paperclipai/shared";
export {
  museHostedNamespaceSchema, museReceiverRecordSchema, museReceiverReferenceSchema,
  museContactBucketSchema, museContactPageSchema, museContactExchangeSchema, museReceiverOwnershipSchema,
  type MuseHostedNamespace, type MuseReceiverRecord, type MuseReceiverReference,
  type MuseContactBucket, type MuseContactPage, type MuseReceiverOwnership,
} from "@paperclipai/shared";

export function museReceiverGeneration(namespace:MuseHostedNamespace,revision:number,records:readonly MuseReceiverRecord[]) {
 if(!Number.isSafeInteger(revision)||revision<0)throw new Error("Invalid Muse receiver revision");
 const rows=records.map(row=>museReceiverRecordSchema.parse(row)).sort((a,b)=>Buffer.compare(Buffer.from(a.bindingId),Buffer.from(b.bindingId)));
 if(rows.length>1000||new Set(rows.map(row=>row.bindingId)).size!==rows.length)throw new Error("Muse receiver projection is incomplete");
 return createHash("sha256").update(JSON.stringify(["paperclip-hosted-muse-v1",museHostedNamespaceSchema.parse(namespace),revision,rows])).digest("hex");
}
export function museContactPageDigest(page:Omit<MuseContactPage,"digest">) {
 return createHash("sha256").update(JSON.stringify(["paperclip-muse-contact-page-v1",page.version,page.namespace,page.recipientNamespace,page.sourceId,page.after,page.through,page.entries])).digest("hex");
}
export function sameMuseNamespace(a:MuseHostedNamespace,b:MuseHostedNamespace){return a.stackId===b.stackId&&a.instanceId===b.instanceId&&a.origin===b.origin;}
export const MUSE_CONTACT_POLICY=Object.freeze({stackRows:20_000,globalRows:100_000,stackBytes:16*1_048_576,globalBytes:256*1_048_576});
// Fixed admission policy, not a measured capacity. Never discard an unacknowledged contact.
