import { z } from "zod";
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const origin=z.string().url().max(2048).refine(value=>{const parsed=new URL(value);return parsed.protocol==="https:"&&parsed.origin===value;});
export const museHostedNamespaceSchema=z.object({stackId:z.string().min(1).max(200),instanceId:z.string().min(1).max(200),origin}).strict();
export const museReceiverRecordSchema=z.object({bindingId:z.uuid(),companyId:z.uuid(),agentId:z.uuid(),operatorId:z.string().min(1).max(200),generation:integer.positive(),
  state:z.enum(["available","idle","retired"]),qualificationExpiresAt:integer.nullable(),
  item:z.object({sourceEventId:z.string().min(1).max(200),attempt:integer,notifiedAt:integer.nullable(),expiresAt:integer.nullable()}).strict().nullable()}).strict().superRefine((row,ctx)=>{
    if(row.state!=="available"&&row.item!==null)ctx.addIssue({code:"custom",message:"Unavailable Muse receiver has a signal"});
  });
export const museReceiverReferenceSchema=z.object({profile:z.literal("hosted-muse-v1"),generation:digest,count:integer.max(1000),contactImportWakeVersion:z.literal(1).optional()}).strict();
export const museContactBucketSchema=z.object({id:z.uuid(),bindingId:z.uuid(),companyId:z.uuid(),generation:integer.positive(),bucketAt:integer,firstAt:integer,lastAt:integer,
  contacts:integer.positive(),gapsAtMostSevenSeconds:integer,maxGapMs:integer,timestamps:z.array(integer).min(1).max(60),incomplete:z.boolean()}).strict().superRefine((row,ctx)=>{
    if(!row.incomplete&&(row.contacts!==row.timestamps.length||row.timestamps.at(-1)!==row.lastAt))ctx.addIssue({code:"custom",message:"Incomplete Muse timestamps were not declared"});
    if(row.bucketAt!==Math.floor(row.firstAt/30_000)*30_000||row.lastAt<row.firstAt||row.timestamps[0]!==row.firstAt||row.timestamps.at(-1)!>row.lastAt||row.contacts<row.timestamps.length||row.gapsAtMostSevenSeconds>=row.contacts+1||row.timestamps.some((at,i)=>i>0&&at<row.timestamps[i-1]!))ctx.addIssue({code:"custom",message:"Invalid Muse contact bucket"});
  });
export const museContactPageSchema=z.object({version:z.literal(1),namespace:museHostedNamespaceSchema,recipientNamespace:museHostedNamespaceSchema,sourceId:z.uuid(),after:integer,through:integer,
  entries:z.array(z.object({sequence:integer.positive(),bucket:museContactBucketSchema}).strict()).max(20),digest}).strict();
export type MuseHostedNamespace=z.infer<typeof museHostedNamespaceSchema>;
export type MuseReceiverRecord=z.infer<typeof museReceiverRecordSchema>;
export type MuseReceiverReference=z.infer<typeof museReceiverReferenceSchema>;
export type MuseContactBucket=z.infer<typeof museContactBucketSchema>;
export type MuseContactPage=z.infer<typeof museContactPageSchema>;

export const museReceiverOwnershipSchema=z.discriminatedUnion("state",[
 z.object({state:z.literal("unowned")}).strict(),
 z.object({state:z.literal("pending")}).strict(),
 z.object({state:z.literal("owned"),namespace:museHostedNamespaceSchema,revision:integer,mirrorGeneration:digest,reference:museReceiverReferenceSchema,sourceId:z.uuid()}).strict(),
]);
export const museContactExchangeSchema=z.object({page:museContactPageSchema,ownership:museReceiverOwnershipSchema}).strict();
export type MuseReceiverOwnership=z.infer<typeof museReceiverOwnershipSchema>;
