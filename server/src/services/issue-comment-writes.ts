import type { PgInsertValue } from "drizzle-orm/pg-core";
import { issueComments, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

type WriteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function insertIssueComment(db: WriteDb, input: PgInsertValue<typeof issueComments> & { companyId: string }) {
  return db.transaction(async tx => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.dotEvents, `company:${input.companyId}`);
    return tx.insert(issueComments).values(input).returning();
  });
}
