import { eq, sql } from "drizzle-orm";
import { mcpOauthClientMirrorState as state, mcpOauthClientChanges as changes, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

const revisions = new WeakMap<object, number>();
export async function prepareMcpClientMutation(tx: Db) {
  const existing = revisions.get(tx);
  if (existing !== undefined) return existing;
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.mcpClientMirror);
  await tx.insert(state).values({id:"public",revision:0}).onConflictDoNothing();
  const [row] = await tx.update(state).set({revision:sql`${state.revision} + 1`}).where(eq(state.id,"public")).returning({revision:state.revision});
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("Invalid MCP client mirror revision");
  revisions.set(tx,row.revision);
  return row.revision;
}
export async function recordMcpClientChange(tx: Db, clientId: string, operation: "upsert"|"delete") {
  const revision = revisions.get(tx);
  if (revision === undefined) throw new Error("MCP client mutation was not prepared");
  await tx.insert(changes).values({clientId,revision,operation}).onConflictDoUpdate({target:changes.clientId,set:{revision,operation}});
}

export async function prepareMcpClientMirrorPolicy(tx:Db,enabled:boolean){
  await prepareMcpClientMutation(tx);
  await tx.update(state).set({enabled,receipt:null}).where(eq(state.id,"public"));
}
